import {
  middleware,
  type MiddlewareConfig,
  type WebhookEvent,
  type MessageEvent,
  type Message,
  type TextMessage,
} from '@line/bot-sdk';
import { Router, type Request, type Response, type NextFunction } from 'express';

import { lineService } from '../services/line';
import { LLMService, LLMServiceError } from '../services/llm';
import { createAppLogger } from '../utils/app-logger';
import { maskToken, maskUserId } from '../utils/logger';

const channelSecret = process.env.LINE_CHANNEL_SECRET;
const FALLBACK_REPLY_TEXT = '抱歉，我现在暂时无法回答，请稍后再试。';
const webhookLogger = createAppLogger('webhook');
const EVENT_DEDUP_TTL_MS = 20 * 60 * 1000;

type WebhookEventProcessingStatus = 'processing' | 'completed' | 'failed';

interface ProcessedWebhookEventRecord {
  status: WebhookEventProcessingStatus;
  expiresAt: number;
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

const getEventUserId = (event: WebhookEvent): string | undefined => {
  if (!isTextMessageEvent(event)) {
    return undefined;
  }

  return event.source.userId ?? 'unknown-user';
};

const getEventMessageId = (event: WebhookEvent): string | undefined => {
  if (!isTextMessageEvent(event)) {
    return undefined;
  }

  return event.message.id;
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

const buildReplyMessage = (text: string): Message => {
  const normalizedText = text.trim();

  return {
    type: 'text',
    text: normalizedText.length > 0
      ? normalizedText.slice(0, 5000)
      : FALLBACK_REPLY_TEXT,
  };
};

const generateReplyText = async (
  userId: string,
  userText: string,
): Promise<string> => {
  try {
    return await LLMService.chat(userId, userText);
  } catch (error) {
    if (error instanceof LLMServiceError) {
      webhookLogger.warn('webhook fallback reply used', {
        userId: maskUserId(userId),
        errorType: error.type,
      });
      return FALLBACK_REPLY_TEXT;
    }

    throw error;
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

  const replyToken = event.replyToken;
  const userId = event.source.userId ?? 'unknown-user';
  const userText = event.message.text;

  webhookLogger.info('webhook text event received', {
    ...eventContext,
    duplicate: false,
    messageLength: userText.length,
  });

  try {
    const replyText = await generateReplyText(userId, userText);
    const replyMessage = buildReplyMessage(replyText);

    await lineService.replyMessage(replyToken, replyMessage, {
      webhookEventId: event.webhookEventId,
      replyToken,
      userId: maskUserId(userId),
      isRedelivery: event.deliveryContext?.isRedelivery,
    });

    markWebhookEvent(event.webhookEventId, 'completed');
    webhookLogger.info('webhook event processed', {
      ...eventContext,
      duplicate: false,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    markWebhookEvent(event.webhookEventId, 'failed');
    webhookLogger.error(
      'failed to process webhook event',
      {
        ...eventContext,
        duplicate: false,
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

      // Ack immediately so LINE will not redeliver while we are still doing LLM work.
      res.json({ status: 'ok' });

      void processWebhookEvents(events);
    } catch (error) {
      next(error);
    }
  },
);

export default router;
