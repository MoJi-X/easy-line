import { createAppLogger } from '../utils/app-logger';
import { maskUserId } from '../utils/logger';

export type MessageBridgeChannel = 'line_webhook' | 'chat_api';

export interface ProcessUserMessageInput {
  channel: MessageBridgeChannel;
  userId: string;
  message: string;
  webhookEventId?: string;
  messageId?: string;
}

export interface ProcessUserMessageResult {
  replyText: string;
  handler: 'bridge_fallback';
  usedTools: string[];
}

const bridgeLogger = createAppLogger('message-bridge');
const MESSAGE_PREVIEW_MAX_LENGTH = 48;
const BRIDGE_REPLY_SUFFIX = '当前已完成 LINE 接入与文本消息桥接，Agent 能力将在下一步接入。';

const normalizeMessageText = (message: string): string => {
  return message.trim().replace(/\s+/g, ' ');
};

const buildMessagePreview = (message: string): string => {
  if (!message) {
    return '空消息';
  }

  if (message.length <= MESSAGE_PREVIEW_MAX_LENGTH) {
    return message;
  }

  return `${message.slice(0, MESSAGE_PREVIEW_MAX_LENGTH)}...`;
};

export const buildBridgeFallbackReplyText = (message: string): string => {
  const normalizedMessage = normalizeMessageText(message);
  const messagePreview = buildMessagePreview(normalizedMessage);

  return `已收到你的消息：“${messagePreview}”。${BRIDGE_REPLY_SUFFIX}`;
};

export class MessageBridgeService {
  async processUserMessage(
    input: ProcessUserMessageInput,
  ): Promise<ProcessUserMessageResult> {
    const normalizedMessage = normalizeMessageText(input.message);

    bridgeLogger.info('message bridge request received', {
      channel: input.channel,
      userId: maskUserId(input.userId),
      messageLength: normalizedMessage.length,
      webhookEventId: input.webhookEventId,
      messageId: input.messageId,
    });

    return {
      replyText: buildBridgeFallbackReplyText(normalizedMessage),
      handler: 'bridge_fallback',
      usedTools: [],
    };
  }
}

export const messageBridgeService = new MessageBridgeService();
