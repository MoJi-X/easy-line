import {
  middleware,
  type MiddlewareConfig,
  type WebhookEvent,
  type MessageEvent,
  type TextMessage,
} from '@line/bot-sdk';
import { Router, type Request, type Response, type NextFunction } from 'express';

import { agentService } from '../services/agent';
import { buildTextMessage, lineService } from '../services/line';
import { createAppLogger } from '../utils/app-logger';
import { maskToken, maskUserId } from '../utils/logger';

const channelSecret = process.env.LINE_CHANNEL_SECRET;
const FALLBACK_REPLY_TEXT = '抱歉，我现在暂时无法处理你的消息，请稍后再试。';
const webhookLogger = createAppLogger('webhook');
const EVENT_DEDUP_TTL_MS = 20 * 60 * 1000;

type WebhookEventProcessingStatus = 'processing' | 'completed' | 'failed';

interface ProcessedWebhookEventRecord {
  status: WebhookEventProcessingStatus;
  expiresAt: number;
}

export interface WebhookTextMessageBridgeRequest {
  webhookEventId: string;
  replyToken: string;
  userId: string;
  messageId?: string;
  messageText: string;
  isRedelivery?: boolean;
}

const processedWebhookEvents = new Map<string, ProcessedWebhookEventRecord>();

if (!channelSecret) {
  throw new Error('Missing required env: LINE_CHANNEL_SECRET');
}

const middlewareConfig: MiddlewareConfig = {
  channelSecret,
};

const router = Router();

const isTextMessageEvent = (
  event: WebhookEvent,
): event is MessageEvent & { message: TextMessage } => {
  return event.type === 'message' && event.message.type === 'text';
};

const isReplyableEvent = (
  event: WebhookEvent,
): event is WebhookEvent & { replyToken: string } => {
  return 'replyToken' in event && typeof event.replyToken === 'string';
};

export const extractWebhookTextMessage = (
  event: WebhookEvent,
): WebhookTextMessageBridgeRequest | null => {
  if (!isTextMessageEvent(event) || !isReplyableEvent(event)) {
    return null;
  }

  return {
    webhookEventId: event.webhookEventId,
    replyToken: event.replyToken,
    userId: event.source.userId ?? 'unknown-user',
    messageId: event.message.id,
    messageText: event.message.text,
    isRedelivery: event.deliveryContext?.isRedelivery,
  };
};

const getEventUserId = (event: WebhookEvent): string | undefined => {
  return extractWebhookTextMessage(event)?.userId;
};

const getEventMessageId = (event: WebhookEvent): string | undefined => {
  return extractWebhookTextMessage(event)?.messageId;
};

const buildEventLogContext = (event: WebhookEvent) => {
  return {
    eventType: event.type,
    userId: (() => {
      const eventUserId = getEventUserId(event);
      return eventUserId ? maskUserId(eventUserId) : undefined;
    })(),
    webhookEventId: event.webhookEventId,
    isRedelivery: event.deliveryContext?.isRedelivery,
    messageId: getEventMessageId(event),
    replyToken: isReplyableEvent(event) ? maskToken(event.replyToken) : undefined,
  };
};

const pruneProcessedWebhookEvents = (): void => {
  const now = Date.now();

  processedWebhookEvents.forEach((record, webhookEventId) => {
    if (record.expiresAt <= now) {
      processedWebhookEvents.delete(webhookEventId);
    }
  });
};

const getProcessedWebhookEvent = (
  webhookEventId: string,
): ProcessedWebhookEventRecord | undefined => {
  pruneProcessedWebhookEvents();
  return processedWebhookEvents.get(webhookEventId);
};

const markWebhookEvent = (
  webhookEventId: string,
  status: WebhookEventProcessingStatus,
): void => {
  processedWebhookEvents.set(webhookEventId, {
    status,
    expiresAt: Date.now() + EVENT_DEDUP_TTL_MS,
  });
};

const replyToWebhookTextMessage = async (
  request: WebhookTextMessageBridgeRequest,
  replyText: string,
): Promise<void> => {
  await lineService.replyMessage(
    request.replyToken,
    buildTextMessage(replyText),
    {
      webhookEventId: request.webhookEventId,
      replyToken: request.replyToken,
      userId: request.userId,
      isRedelivery: request.isRedelivery,
    },
  );
};

const sendFallbackReply = async (
  request: WebhookTextMessageBridgeRequest,
): Promise<boolean> => {
  try {
    await replyToWebhookTextMessage(request, FALLBACK_REPLY_TEXT);
    return true;
  } catch (error) {
    webhookLogger.error(
      'failed to send webhook fallback reply',
      {
        webhookEventId: request.webhookEventId,
        userId: maskUserId(request.userId),
        messageId: request.messageId,
        replyToken: maskToken(request.replyToken),
      },
      error,
    );
    return false;
  }
};

const handleEvent = async (event: WebhookEvent): Promise<void> => {
  const startedAt = Date.now();
  const eventContext = buildEventLogContext(event);
  const existingRecord = getProcessedWebhookEvent(event.webhookEventId);

  if (existingRecord) {
    webhookLogger.warn('duplicate webhook event skipped', {
      ...eventContext,
      duplicate: true,
      duplicateStatus: existingRecord.status,
      durationMs: Date.now() - startedAt,
    });
    return;
  }

  markWebhookEvent(event.webhookEventId, 'processing');

  if (!isTextMessageEvent(event)) {
    webhookLogger.info('webhook event skipped because it is not a text message', {
      ...eventContext,
      duplicate: false,
      durationMs: Date.now() - startedAt,
    });
    markWebhookEvent(event.webhookEventId, 'completed');
    return;
  }

  const textMessage = extractWebhookTextMessage(event);

  if (!textMessage) {
    webhookLogger.warn('webhook text event skipped because reply context is missing', {
      ...eventContext,
      duplicate: false,
      durationMs: Date.now() - startedAt,
    });
    markWebhookEvent(event.webhookEventId, 'failed');
    return;
  }

  webhookLogger.info('webhook text event received', {
    ...eventContext,
    duplicate: false,
    messageLength: textMessage.messageText.length,
  });

  try {
    const agentResult = await agentService.processUserMessage({
      channel: 'line_webhook',
      userId: textMessage.userId,
      message: textMessage.messageText,
      webhookEventId: textMessage.webhookEventId,
      messageId: textMessage.messageId,
    });

    await replyToWebhookTextMessage(textMessage, agentResult.reply);

    markWebhookEvent(event.webhookEventId, 'completed');
    webhookLogger.info('webhook event processed', {
      ...eventContext,
      duplicate: false,
      usedToolCount: agentResult.usedTools.length,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const fallbackSent = await sendFallbackReply(textMessage);

    markWebhookEvent(event.webhookEventId, fallbackSent ? 'completed' : 'failed');
    webhookLogger.error(
      'failed to process webhook event',
      {
        ...eventContext,
        duplicate: false,
        fallbackSent,
        durationMs: Date.now() - startedAt,
      },
      error,
    );
  }
};

const processWebhookEvents = async (events: WebhookEvent[]): Promise<void> => {
  const results = await Promise.allSettled(events.map(async (event) => {
    await handleEvent(event);
  }));

  const rejectedCount = results.filter(
    (result) => result.status === 'rejected',
  ).length;

  if (rejectedCount > 0) {
    webhookLogger.error(
      'webhook event processing settled with unexpected rejections',
      {
        eventCount: events.length,
        rejectedCount,
      },
    );
  }
};

router.post(
  '/webhook',
  middleware(middlewareConfig),
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const events = ((req.body as { events?: WebhookEvent[] }).events ?? []) as WebhookEvent[];

      // Ack immediately so LINE will not redeliver while the bridge handles events asynchronously.
      res.json({ status: 'ok' });

      void processWebhookEvents(events);
    } catch (error) {
      next(error);
    }
  },
);

export default router;
