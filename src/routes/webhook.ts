import { MessageEvent, TextEventMessage, WebhookEvent } from "@line/bot-sdk";
import { Router } from "express";

import { LLMService } from "../services/llm";
import { lineMiddleware, LineService } from "../services/line";

const MODULE_NAME = "WebhookRoute";
const FALLBACK_REPLY = "抱歉，我现在有点忙，请稍后再试 🙏";

const router = Router();

const isTextMessageEvent = (
  event: WebhookEvent,
): event is MessageEvent & { message: TextEventMessage } => {
  return event.type === "message" && event.message.type === "text";
};

const handleTextMessage = async (
  event: MessageEvent & { message: TextEventMessage },
): Promise<void> => {
  const userId = event.source.userId;

  if (!userId) {
    return;
  }

  try {
    const reply = await LLMService.chat(userId, event.message.text);
    await LineService.replyText(event.replyToken, reply || FALLBACK_REPLY);
  } catch {
    console.error(`[${MODULE_NAME}] errorType=LLM_FALLBACK`);
    await LineService.replyText(event.replyToken, FALLBACK_REPLY);
  }
};

router.post("/webhook", lineMiddleware, async (req, res) => {
  const events = req.body.events as WebhookEvent[];

  await Promise.all(
    events.map(async (event) => {
      if (!isTextMessageEvent(event)) {
        return;
      }

      await handleTextMessage(event);
    }),
  );

  res.status(200).json({ ok: true });
});

export default router;
