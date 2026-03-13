import {
  middleware,
  type MiddlewareConfig,
  type WebhookEvent,
  type MessageEvent,
  type TextMessage,
} from '@line/bot-sdk';
import { Router, type Request, type Response, type NextFunction } from 'express';

import { lineService } from '../services/line';
import { LLMService, LLMServiceError } from '../services/llm';
import { createAppLogger } from '../utils/app-logger';
import { maskUserId } from '../utils/logger';

const channelSecret = process.env.LINE_CHANNEL_SECRET;
const FALLBACK_REPLY_TEXT = '抱歉，我现在暂时无法回答，请稍后再试。';
const webhookLogger = createAppLogger('webhook');

if (!channelSecret) {
  throw new Error('Missing required env: LINE_CHANNEL_SECRET');
}

const middlewareConfig: MiddlewareConfig = {
  channelSecret,
};

const router = Router();

const isTextMessageEvent = (event: WebhookEvent): event is MessageEvent & { message: TextMessage } => {
  return event.type === 'message' && event.message.type === 'text';
};

const getEventUserId = (event: WebhookEvent): string | undefined => {
  if (!isTextMessageEvent(event)) {
    return undefined;
  }

  return event.source.userId ?? 'unknown-user';
};

const generateReplyText = async (userId: string, userText: string): Promise<string> => {
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
  if (!isTextMessageEvent(event)) {
    webhookLogger.info('webhook event skipped because it is not a text message', {
      eventType: event.type,
    });
    return;
  }

  const replyToken = event.replyToken;
  const userId = event.source.userId ?? 'unknown-user';
  const userText = event.message.text;

  webhookLogger.info('webhook text event received', {
    eventType: event.type,
    userId: maskUserId(userId),
    messageLength: userText.length,
  });

  const replyText = await generateReplyText(userId, userText);

  await lineService.replyMessage(replyToken, {
    type: 'text',
    text: replyText,
  });
};

router.post('/webhook', middleware(middlewareConfig), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const events = ((req.body as { events?: WebhookEvent[] }).events ?? []) as WebhookEvent[];

    await Promise.all(
      events.map(async (event) => {
        try {
          await handleEvent(event);
        } catch (error) {
          const eventUserId = getEventUserId(event);

          webhookLogger.error(
            'failed to process webhook event',
            {
              eventType: event.type,
              userId: eventUserId ? maskUserId(eventUserId) : undefined,
            },
            error,
          );
        }
      }),
    );

    res.json({ status: 'ok' });
  } catch (error) {
    next(error);
  }
});

export default router;
