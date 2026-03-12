import { Client, type Message, type ClientConfig } from '@line/bot-sdk';

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

  async replyMessage(replyToken: string, messages: Message | Message[]): Promise<void> {
    await this.client.replyMessage(replyToken, messages);
  }

  async pushMessage(to: string, messages: Message | Message[]): Promise<void> {
    await this.client.pushMessage(to, messages);
  }

  async multicast(to: string[], messages: Message | Message[]): Promise<void> {
    await this.client.multicast(to, messages);
  }
}

export const lineService = new LineService();
