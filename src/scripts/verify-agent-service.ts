import type { AgentRuntime } from '../services/agent';
import type { AgentTool } from '../tools';

process.env.LINE_CHANNEL_SECRET ??= 'verify-line-secret';
process.env.LINE_CHANNEL_ACCESS_TOKEN ??= 'verify-line-token';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const {
  createAgent,
  FakeToolCallingModel,
} = require('langchain') as typeof import('langchain');
const { createToolRegistry } = require('../tools') as typeof import('../tools');
const {
  createTavilySearchTool,
} = require('../tools/tavily-search') as typeof import('../tools/tavily-search');
const { AgentService } = require('../services/agent') as typeof import('../services/agent');
type RegisteredTools = AgentTool[];

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

const buildFakeRuntimeAgent = (
  tools: RegisteredTools,
): AgentRuntime => {
  const createRuntime = createAgent as unknown as (params: {
    model: InstanceType<typeof FakeToolCallingModel>;
    tools: RegisteredTools;
    systemPrompt: string;
  }) => AgentRuntime;

  return createRuntime({
    model: new FakeToolCallingModel({
      toolCalls: [
        [
          {
            name: 'search.tavily',
            args: {
              query: 'latest AI news',
            },
            id: 'tool-call-1',
          },
        ],
        [],
      ],
    }),
    tools,
    systemPrompt: '你是 easy-line Agent 验证模型。',
  });
};

const verify = async (): Promise<void> => {
  const tavilyTool = createTavilySearchTool({
    apiWrapper: {
      rawResults: async (params) => {
        return {
          query: params.query,
          answer: '这是一个测试摘要。',
          results: [
            {
              title: '测试来源',
              url: 'https://example.com/latest-ai-news',
              content: '这里是测试搜索结果内容。',
              score: 0.99,
              raw_content: null,
            },
          ],
          response_time: 0.01,
        };
      },
    },
  });
  const toolOutput = await tavilyTool.invoke({
    query: 'latest AI news',
  });

  assert.match(toolOutput, /search\.tavily|搜索摘要|测试来源/u);

  const degradedTavilyTool = createTavilySearchTool({
    apiWrapper: {
      rawResults: async () => {
        throw new Error('upstream unavailable');
      },
    },
  });
  const degradedToolOutput = await degradedTavilyTool.invoke({
    query: 'latest AI news',
  });

  assert.match(degradedToolOutput, /实时搜索当前不可用/u);

  const toolRegistry = createToolRegistry({
    tavilySearch: {
      apiWrapper: {
        rawResults: async (params) => {
          return {
            query: params.query,
            answer: '这是一个测试摘要。',
            results: [
              {
                title: '测试来源',
                url: 'https://example.com/latest-ai-news',
                content: '这里是测试搜索结果内容。',
                score: 0.99,
                raw_content: null,
              },
            ],
            response_time: 0.01,
          };
        },
      },
    },
  });

  const service = new AgentService({
    createRuntimeAgent: buildFakeRuntimeAgent,
    toolRegistry,
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

  assert.equal(fourthResult.usedTools.length, 1);
  assert.deepEqual(fourthResult.usedTools, ['search.tavily']);
  assert.match(fourthResult.reply, /测试来源/u);

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
  assert.deepEqual(service.getRegisteredToolNames(), [
    'search.tavily',
    'task.create',
    'task.list',
    'task.update',
    'task.delete',
    'create_alarm_session',
    'list_alarms',
    'analyze_alarm',
    'create_work_order',
  ]);

  console.info('AgentService verification passed.');
};

void verify().catch((error: unknown) => {
  console.error('AgentService verification failed.', error);
  process.exitCode = 1;
});
