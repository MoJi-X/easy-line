import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { LanguageModelLike } from '@langchain/core/language_models/base';
import { ChatOpenAI } from '@langchain/openai';
import { createAgent } from 'langchain';

import { config } from '../config';
import { AppError } from '../errors/app-error';
import {
  createToolRegistry,
  type AgentTool,
  type ToolRegistry,
} from '../tools';
import { createAppLogger } from '../utils/app-logger';
import { maskUserId } from '../utils/logger';

const MAX_CONTEXT_ROUNDS = 3;
const MAX_CONTEXT_MESSAGES = MAX_CONTEXT_ROUNDS * 2;
const DEFAULT_AGENT_TIMEOUT_MS = 8000;
const INVALID_AGENT_REPLY_TEXT = '抱歉，我暂时无法生成有效回复，请稍后再试。';
const agentLogger = createAppLogger('agent');

const AGENT_SYSTEM_PROMPT = [
  '你是 easy-line Demo 的统一消息 Agent。',
  '请优先使用简洁、自然的中文回复用户。',
  '当问题依赖最新、当前、实时、今天、本周、近期变化的外部信息时，优先调用 `search.tavily` 再回答。',
  '如果 `search.tavily` 返回搜索不可用、超时或未配置，请直接告诉用户当前无法获取最新外部信息，不要编造答案。',
  '当前尚未接入任务 CRUD、天气调度和 JSON 持久化，不要假装已经创建、修改、删除或执行任何任务。',
  '对于不需要实时外部信息的稳定问题，可以直接回答。',
].join('\n');

export type AgentChannel = 'line_webhook' | 'chat_api';

export interface ProcessUserMessageInput {
  channel: AgentChannel;
  userId: string;
  message: string;
  webhookEventId?: string;
  messageId?: string;
}

export interface NormalizedUserMessageInput {
  channel: AgentChannel;
  userId: string;
  message: string;
  rawMessage: string;
  webhookEventId?: string;
  messageId?: string;
}

export interface ProcessUserMessageResult {
  reply: string;
  usedTools: string[];
}

export type AgentRuntimeResult = {
  messages?: BaseMessage[];
};

export type AgentRuntime = {
  invoke: (state: { messages: BaseMessage[] }) => Promise<AgentRuntimeResult>;
};

type AgentTools = AgentTool[];

type AgentServiceErrorType =
  | 'INVALID_ARGUMENT'
  | 'MISSING_API_KEY'
  | 'AGENT_INIT_FAILED'
  | 'AGENT_INVOCATION_FAILED';

interface AgentServiceOptions {
  createRuntimeAgent?: (tools: AgentTools) => AgentRuntime;
  memoryStore?: AgentConversationMemory;
  toolRegistry?: ToolRegistry<AgentTool>;
}

export class AgentServiceError extends Error {
  constructor(
    public readonly type: AgentServiceErrorType,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AgentServiceError';
  }
}

export const normalizeUserMessageInput = (
  input: ProcessUserMessageInput,
): NormalizedUserMessageInput => {
  const userId = input.userId.trim();
  const rawMessage = input.message.trim();

  if (!userId) {
    throw new AgentServiceError(
      'INVALID_ARGUMENT',
      'userId must be a non-empty string.',
    );
  }

  if (!rawMessage) {
    throw new AgentServiceError(
      'INVALID_ARGUMENT',
      'message must be a non-empty string.',
    );
  }

  return {
    channel: input.channel,
    userId,
    message: rawMessage,
    rawMessage,
    webhookEventId: input.webhookEventId,
    messageId: input.messageId,
  };
};

export const trimConversationMessages = (
  messages: BaseMessage[],
): BaseMessage[] => {
  if (messages.length <= MAX_CONTEXT_MESSAGES) {
    return messages;
  }

  return messages.slice(-MAX_CONTEXT_MESSAGES);
};

export class AgentConversationMemory {
  private readonly userMemories = new Map<string, BaseMessage[]>();

  getUserContext(userId: string): BaseMessage[] {
    return [...(this.userMemories.get(userId) ?? [])];
  }

  saveConversationTurn(
    userId: string,
    message: string,
    reply: string,
  ): BaseMessage[] {
    const nextContext = trimConversationMessages([
      ...this.getUserContext(userId),
      new HumanMessage(message),
      new AIMessage(reply),
    ]);

    this.userMemories.set(userId, nextContext);
    return [...nextContext];
  }
}

const extractTextFromContentPart = (part: unknown): string => {
  if (typeof part === 'string') {
    return part;
  }

  if (!part || typeof part !== 'object') {
    return '';
  }

  if ('text' in part && typeof part.text === 'string') {
    return part.text;
  }

  return '';
};

const normalizeResponseText = (content: unknown): string => {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content.map(extractTextFromContentPart).join('').trim();
  }

  return '';
};

const extractReplyFromMessages = (messages: BaseMessage[]): string => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (!AIMessage.isInstance(message)) {
      continue;
    }

    const reply = normalizeResponseText(message.content);

    if (reply) {
      return reply;
    }
  }

  return INVALID_AGENT_REPLY_TEXT;
};

const extractUsedTools = (messages: BaseMessage[]): string[] => {
  const usedTools = new Set<string>();

  messages.forEach((message) => {
    if (!AIMessage.isInstance(message) || !Array.isArray(message.tool_calls)) {
      return;
    }

    message.tool_calls.forEach((toolCall) => {
      if (toolCall.name) {
        usedTools.add(toolCall.name);
      }
    });
  });

  return [...usedTools];
};

const createChatModel = (): LanguageModelLike => {
  if (!config.llmApiKey) {
    throw new AgentServiceError(
      'MISSING_API_KEY',
      'LLM_API_KEY is missing.',
    );
  }

  return new ChatOpenAI({
    model: config.llmModel,
    temperature: 0.2,
    apiKey: config.llmApiKey,
    timeout: DEFAULT_AGENT_TIMEOUT_MS,
    configuration: config.llmBaseUrl
      ? {
          baseURL: config.llmBaseUrl,
        }
      : undefined,
  });
};

const createRuntimeAgent = (
  tools: AgentTools,
): AgentRuntime => {
  try {
    const createRuntime = createAgent as unknown as (params: {
      model: LanguageModelLike;
      tools: AgentTools;
      systemPrompt: string;
    }) => AgentRuntime;

    return createRuntime({
      model: createChatModel(),
      tools,
      systemPrompt: AGENT_SYSTEM_PROMPT,
    });
  } catch (error) {
    if (error instanceof AgentServiceError) {
      throw error;
    }

    throw new AgentServiceError(
      'AGENT_INIT_FAILED',
      'Failed to initialize Agent runtime.',
      error,
    );
  }
};

export const mapAgentErrorToAppError = (error: unknown): AppError => {
  if (!(error instanceof AgentServiceError)) {
    return new AppError(500, 'INTERNAL_ERROR', 'Internal server error.');
  }

  if (error.type === 'INVALID_ARGUMENT') {
    return new AppError(400, 'INVALID_ARGUMENT', error.message);
  }

  if (
    error.type === 'MISSING_API_KEY' ||
    error.type === 'AGENT_INIT_FAILED' ||
    error.type === 'AGENT_INVOCATION_FAILED'
  ) {
    return new AppError(502, 'EXTERNAL_SERVICE_ERROR', error.message);
  }

  return new AppError(500, 'INTERNAL_ERROR', 'Internal server error.');
};

export class AgentService {
  private runtimeAgent?: AgentRuntime;

  private readonly memoryStore: AgentConversationMemory;

  private readonly createRuntimeAgent: (tools: AgentTools) => AgentRuntime;

  private readonly toolRegistry: ToolRegistry<AgentTool>;

  constructor(options: AgentServiceOptions = {}) {
    this.memoryStore = options.memoryStore ?? new AgentConversationMemory();
    this.toolRegistry = options.toolRegistry ?? createToolRegistry();
    this.createRuntimeAgent = options.createRuntimeAgent ?? createRuntimeAgent;
  }

  getUserContext(userId: string): BaseMessage[] {
    return this.memoryStore.getUserContext(userId);
  }

  getRegisteredToolNames(): string[] {
    return this.toolRegistry.getNames();
  }

  private getOrCreateRuntimeAgent(): AgentRuntime {
    if (!this.runtimeAgent) {
      this.runtimeAgent = this.createRuntimeAgent(this.toolRegistry.getAll());
    }

    return this.runtimeAgent;
  }

  async processUserMessage(
    input: ProcessUserMessageInput,
  ): Promise<ProcessUserMessageResult> {
    const normalizedInput = normalizeUserMessageInput(input);
    const history = this.memoryStore.getUserContext(normalizedInput.userId);
    const requestMessages = [
      ...history,
      new HumanMessage(normalizedInput.message),
    ];

    agentLogger.info('agent request received', {
      channel: normalizedInput.channel,
      userId: maskUserId(normalizedInput.userId),
      webhookEventId: normalizedInput.webhookEventId,
      messageId: normalizedInput.messageId,
      historyMessageCount: history.length,
      requestMessageCount: requestMessages.length,
      registeredToolCount: this.toolRegistry.getNames().length,
    });

    try {
      const result = await this.getOrCreateRuntimeAgent().invoke({
        messages: requestMessages,
      });
      const resultMessages = Array.isArray(result.messages)
        ? result.messages
        : [];
      const reply = extractReplyFromMessages(resultMessages);
      const usedTools = extractUsedTools(resultMessages);
      const nextContext = this.memoryStore.saveConversationTurn(
        normalizedInput.userId,
        normalizedInput.rawMessage,
        reply,
      );

      agentLogger.info('agent response generated', {
        channel: normalizedInput.channel,
        userId: maskUserId(normalizedInput.userId),
        webhookEventId: normalizedInput.webhookEventId,
        messageId: normalizedInput.messageId,
        usedToolCount: usedTools.length,
        contextMessageCount: nextContext.length,
        replyLength: reply.length,
      });

      return {
        reply,
        usedTools,
      };
    } catch (error) {
      const wrappedError =
        error instanceof AgentServiceError
          ? error
          : new AgentServiceError(
              'AGENT_INVOCATION_FAILED',
              'Failed to generate agent response.',
              error,
            );

      agentLogger.error(
        'agent request failed',
        {
          channel: normalizedInput.channel,
          userId: maskUserId(normalizedInput.userId),
          webhookEventId: normalizedInput.webhookEventId,
          messageId: normalizedInput.messageId,
          errorType: wrappedError.type,
        },
        wrappedError,
      );

      throw wrappedError;
    }
  }
}

export const agentService = new AgentService();
