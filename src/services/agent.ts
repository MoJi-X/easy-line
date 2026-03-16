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
  '当前仅启用了统一 Agent 入口和按 userId 维护的短期上下文。',
  'Tavily 搜索、任务工具、天气调度和 JSON 持久化尚未接入，不要假装已经执行这些能力。',
  '如果用户请求尚未接入的能力，请明确说明当前阶段暂不支持，并引导用户稍后再试。',
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

type AgentServiceErrorType =
  | 'INVALID_ARGUMENT'
  | 'MISSING_API_KEY'
  | 'AGENT_INIT_FAILED'
  | 'AGENT_INVOCATION_FAILED';

interface AgentServiceOptions {
  createRuntimeAgent?: () => AgentRuntime;
  memoryStore?: AgentConversationMemory;
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

const createRuntimeAgent = (): AgentRuntime => {
  try {
    const createRuntime = createAgent as unknown as (params: {
      model: LanguageModelLike;
      tools: [];
      systemPrompt: string;
    }) => AgentRuntime;

    return createRuntime({
      model: createChatModel(),
      tools: [],
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

  private readonly createRuntimeAgent: () => AgentRuntime;

  constructor(options: AgentServiceOptions = {}) {
    this.memoryStore = options.memoryStore ?? new AgentConversationMemory();
    this.createRuntimeAgent = options.createRuntimeAgent ?? createRuntimeAgent;
  }

  getUserContext(userId: string): BaseMessage[] {
    return this.memoryStore.getUserContext(userId);
  }

  private getOrCreateRuntimeAgent(): AgentRuntime {
    if (!this.runtimeAgent) {
      this.runtimeAgent = this.createRuntimeAgent();
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
