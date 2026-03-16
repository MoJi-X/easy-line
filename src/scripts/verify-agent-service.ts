import type { AgentRuntime } from '../services/agent';

process.env.LINE_CHANNEL_SECRET ??= 'verify-line-secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN ??= 'verify-line-token';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const {
  createAgent,
  FakeToolCallingModel,
} = require('langchain') as typeof import('langchain');
const { AgentService } = require('../services/agent') as typeof import('../services/agent');

const normalizeMessageContent = (content: unknown): string => {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }

      if (part && typeof part === 'object' && 'text' in part) {
        return typeof part.text === 'string' ? part.text : '';
      }

      return '';
    })
    .join('');
};

const buildFakeRuntimeAgent = (): AgentRuntime => {
  const createRuntime = createAgent as unknown as (params: {
    model: InstanceType<typeof FakeToolCallingModel>;
    tools: [];
    systemPrompt: string;
  }) => AgentRuntime;

  return createRuntime({
    model: new FakeToolCallingModel(),
    tools: [],
    systemPrompt: '你是 easy-line Agent 验证模型。',
  });
};

const verify = async (): Promise<void> => {
  const service = new AgentService({
    createRuntimeAgent: buildFakeRuntimeAgent,
  });

  await service.processUserMessage({
    channel: 'chat_api',
    userId: ' user-1 ',
    message: '  first from chat  ',
  });
  await service.processUserMessage({
    channel: 'line_webhook',
    userId: 'user-1',
    message: 'second from webhook',
  });
  await service.processUserMessage({
    channel: 'chat_api',
    userId: 'user-1',
    message: 'third from chat',
  });
  const fourthResult = await service.processUserMessage({
    channel: 'line_webhook',
    userId: 'user-1',
    message: 'fourth from webhook',
  });

  assert.equal(fourthResult.usedTools.length, 0);

  const userOneContext = service.getUserContext('user-1');
  assert.equal(userOneContext.length, 6);

  const userOneHumanMessages = userOneContext
    .filter((message) => message.getType() === 'human')
    .map((message) => normalizeMessageContent(message.content));

  assert.deepEqual(userOneHumanMessages, [
    'second from webhook',
    'third from chat',
    'fourth from webhook',
  ]);

  await service.processUserMessage({
    channel: 'chat_api',
    userId: 'user-2',
    message: '  isolated user context  ',
  });

  const userTwoContext = service.getUserContext('user-2');
  assert.equal(userTwoContext.length, 2);
  assert.equal(
    normalizeMessageContent(userTwoContext[0]?.content),
    'isolated user context',
  );
  assert.equal(service.getUserContext('user-1').length, 6);

  console.info('AgentService verification passed.');
};

void verify().catch((error: unknown) => {
  console.error('AgentService verification failed.', error);
  process.exitCode = 1;
});
