import { Client, MiddlewareConfig, TextMessage, middleware } from "@line/bot-sdk";

import { config } from "../config";

const lineConfig: MiddlewareConfig = {
  channelSecret: config.lineChannelSecret,
  channelAccessToken: config.lineChannelAccessToken,
};

const client = new Client(lineConfig);

export const lineMiddleware = middleware(lineConfig);

export const LineService = {
  async replyText(replyToken: string, text: string): Promise<void> {
    const message: TextMessage = {
      type: "text",
      text,
    };

    await client.replyMessage(replyToken, message);
  },
};
