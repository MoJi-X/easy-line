import {
  Client,
  HTTPError,
  type Message,
  type ClientConfig,
  type TextMessage,
} from '@line/bot-sdk';
import type { AxiosError } from 'axios';

import { createAppLogger } from '../utils/app-logger';
import { maskToken, maskUserId } from '../utils/logger';

export interface LineMessageContext {
  webhookEventId?: string;
  replyToken?: string;
  userId?: string;
  to?: string;
  targetCount?: number;
  isRedelivery?: boolean;
}

const lineLogger = createAppLogger('line');
const LINE_REQUEST_ID_HEADER = 'x-line-request-id';
const DEFAULT_REPLY_TEXT = '抱歉，我现在暂时无法回答，请稍后再试。';
type LineSendOperation = 'replyMessage' | 'pushMessage' | 'multicast';

const isTextMessage = (
  message: Message,
): message is Message & { type: 'text'; text: string } => {
  return message.type === 'text';
};

const normalizeTextMessage = (text: string): string => {
  const normalizedText = text.trim();

  return normalizedText.length > 0
    ? normalizedText.slice(0, 5000)
    : DEFAULT_REPLY_TEXT;
};

export const buildTextMessage = (text: string): TextMessage => {
  return {
    type: 'text',
    text: normalizeTextMessage(text),
  };
};

const normalizeMessages = (messages: Message | Message[]): Message[] => {
  const messageList = Array.isArray(messages) ? messages : [messages];

  return messageList.map((message) => {
    if (!isTextMessage(message)) {
      return message;
    }

    return {
      ...message,
      text: normalizeTextMessage(message.text),
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

const getLineRequestId = (response: unknown): string | undefined => {
  if (!response || typeof response !== 'object') {
    return undefined;
  }

  const requestId = (response as Record<string, unknown>)[LINE_REQUEST_ID_HEADER];
  return typeof requestId === 'string' ? requestId : undefined;
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

  private async sendMessages(
    operation: LineSendOperation,
    messages: Message | Message[],
    context: LineMessageContext,
    send: (normalizedMessages: Message[]) => Promise<unknown>,
  ): Promise<void> {
    const normalizedMessages = normalizeMessages(messages);

    try {
      const response = await send(normalizedMessages);

      lineLogger.info(`line ${operation} succeeded`, {
        webhookEventId: context.webhookEventId,
        replyToken: context.replyToken ? maskToken(context.replyToken) : undefined,
        userId: context.userId ? maskUserId(context.userId) : undefined,
        targetUserId: context.to ? maskUserId(context.to) : undefined,
        targetCount: context.targetCount,
        isRedelivery: context.isRedelivery,
        lineStatus: 200,
        lineRequestId: getLineRequestId(response),
        lineResponseBody: JSON.stringify(response),
        messageCount: normalizedMessages.length,
      });
    } catch (error) {
      const errorDetails = getAxiosErrorDetails(error);

      lineLogger.error(
        `line ${operation} failed`,
        {
          webhookEventId: context.webhookEventId,
          replyToken: context.replyToken ? maskToken(context.replyToken) : undefined,
          userId: context.userId ? maskUserId(context.userId) : undefined,
          targetUserId: context.to ? maskUserId(context.to) : undefined,
          targetCount: context.targetCount,
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

  async replyMessage(
    replyToken: string,
    messages: Message | Message[],
    context: LineMessageContext = {},
  ): Promise<void> {
    await this.sendMessages(
      'replyMessage',
      messages,
      {
        ...context,
        replyToken,
      },
      async (normalizedMessages) => this.client.replyMessage(replyToken, normalizedMessages),
    );
  }

  async pushMessage(to: string, messages: Message | Message[]): Promise<void> {
    await this.sendMessages(
      'pushMessage',
      messages,
      {
        to,
        targetCount: 1,
      },
      async (normalizedMessages) => this.client.pushMessage(to, normalizedMessages),
    );
  }

  async multicast(
    to: string[],
    messages: Message | Message[],
    context: LineMessageContext = {},
  ): Promise<void> {
    await this.sendMessages(
      'multicast',
      messages,
      {
        ...context,
        targetCount: to.length,
      },
      async (normalizedMessages) => this.client.multicast(to, normalizedMessages),
    );
  }
}

export const lineService = new LineService();
