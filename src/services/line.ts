import { Client, HTTPError, type Message, type ClientConfig } from '@line/bot-sdk';
import type { AxiosError } from 'axios';

import { createAppLogger } from '../utils/app-logger';
import { maskToken } from '../utils/logger';

interface ReplyMessageContext {
  webhookEventId?: string;
  replyToken?: string;
  userId?: string;
  isRedelivery?: boolean;
}

const lineLogger = createAppLogger('line');
const LINE_REQUEST_ID_HEADER = 'x-line-request-id';
const DEFAULT_REPLY_TEXT = '抱歉，我现在暂时无法回答，请稍后再试。';

const isTextMessage = (
  message: Message,
): message is Message & { type: 'text'; text: string } => {
  return message.type === 'text';
};

const normalizeReplyMessages = (messages: Message | Message[]): Message[] => {
  const messageList = Array.isArray(messages) ? messages : [messages];

  return messageList.map((message) => {
    if (!isTextMessage(message)) {
      return message;
    }

    const normalizedText = message.text.trim();
    const text = normalizedText.length > 0
      ? normalizedText.slice(0, 5000)
      : DEFAULT_REPLY_TEXT;

    return {
      ...message,
      text,
    };
  });
};

const getAxiosErrorDetails = (
  error: unknown,
): {
  statusCode?: number;
  responseData?: string;
  lineRequestId?: string;
} => {
  const httpError = error instanceof HTTPError ? error : undefined;
  const originalError = httpError?.originalError as AxiosError | undefined;
  const response = originalError?.response;
  const responseData = response?.data;
  const responseHeaders = response?.headers as Record<string, unknown> | undefined;
  const lineRequestIdHeader = responseHeaders?.[LINE_REQUEST_ID_HEADER];

  return {
    statusCode: httpError?.statusCode ?? response?.status,
    responseData:
      responseData === undefined ? undefined : JSON.stringify(responseData),
    lineRequestId:
      typeof lineRequestIdHeader === 'string' ? lineRequestIdHeader : undefined,
  };
};

const createLineClient = (): Client => {
  const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;

  if (!channelAccessToken) {
    throw new Error('Missing required env: LINE_CHANNEL_ACCESS_TOKEN');
  }

  const config: ClientConfig = {
    channelAccessToken,
  };

  return new Client(config);
};

export class LineService {
  private readonly client: Client;

  constructor(client: Client = createLineClient()) {
    this.client = client;
  }

  async replyMessage(
    replyToken: string,
    messages: Message | Message[],
    context: ReplyMessageContext = {},
  ): Promise<void> {
    const normalizedMessages = normalizeReplyMessages(messages);

    try {
      const response = await this.client.replyMessage(
        replyToken,
        normalizedMessages,
      );

      lineLogger.info('line replyMessage succeeded', {
        webhookEventId: context.webhookEventId,
        replyToken: maskToken(context.replyToken ?? replyToken),
        userId: context.userId,
        isRedelivery: context.isRedelivery,
        lineStatus: 200,
        lineRequestId:
          typeof response[LINE_REQUEST_ID_HEADER] === 'string'
            ? response[LINE_REQUEST_ID_HEADER]
            : undefined,
        lineResponseBody: JSON.stringify(response),
        messageCount: normalizedMessages.length,
      });
    } catch (error) {
      const errorDetails = getAxiosErrorDetails(error);

      lineLogger.error(
        'line replyMessage failed',
        {
          webhookEventId: context.webhookEventId,
          replyToken: maskToken(context.replyToken ?? replyToken),
          userId: context.userId,
          isRedelivery: context.isRedelivery,
          lineStatus: errorDetails.statusCode,
          lineRequestId: errorDetails.lineRequestId,
          lineResponseBody: errorDetails.responseData,
          messageCount: normalizedMessages.length,
        },
        error,
      );

      throw error;
    }
  }

  async pushMessage(to: string, messages: Message | Message[]): Promise<void> {
    await this.client.pushMessage(to, messages);
  }

  async multicast(to: string[], messages: Message | Message[]): Promise<void> {
    await this.client.multicast(to, messages);
  }
}

export const lineService = new LineService();
