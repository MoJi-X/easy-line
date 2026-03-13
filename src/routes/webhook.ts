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

const channelSecret = process.env.LINE_CHANNEL_SECRET;
const FALLBACK_REPLY_TEXT = '抱歉，我現在暫時無法回答，請稍後再試。';

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

const generateReplyText = async (userId: string, userText: string): Promise<string> => {
  try {
    return await LLMService.chat(userId, userText);
  } catch (error) {
    if (error instanceof LLMServiceError) {
      console.warn(`[webhook] fallback reply for userId=${userId}, errorType=${error.type}`);
      return FALLBACK_REPLY_TEXT;
    }

    throw error;
  }
};

const handleEvent = async (event: WebhookEvent): Promise<void> => {
  if (!isTextMessageEvent(event)) {
    console.info(`[webhook] skip non-text event: type=${event.type}`);
    return;
  }

  const replyToken = event.replyToken;
  const userId = event.source.userId ?? 'unknown-user';
  const userText = event.message.text;

  console.info(`[webhook] text event received from userId=${userId}, text="${userText}"`);
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
          console.error('[webhook] failed to process event', error);
        }
      }),
    );

    res.json({ status: 'ok' });
  } catch (error) {
    next(error);
  }
});

export default router;
