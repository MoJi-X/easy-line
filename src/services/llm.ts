import { ChatOpenAI } from "@langchain/openai";
import { ConversationChain } from "langchain/chains";
import { BufferMemory } from "langchain/memory";

import { config } from "../config";

const MODULE_NAME = "LLMService";
const MAX_CONTEXT_ROUNDS = 3;
const MAX_CONTEXT_MESSAGES = MAX_CONTEXT_ROUNDS * 2;

export type LLMServiceErrorType =
  | "MISSING_API_KEY"
  | "MODEL_INIT_FAILED"
  | "MODEL_CALL_FAILED";

export class LLMServiceError extends Error {
  constructor(
    public readonly type: LLMServiceErrorType,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LLMServiceError";
  }
}

const userMemories = new Map<string, BufferMemory>();

const maskUserId = (userId: string): string => {
  if (userId.length < 6) {
    return "****";
  }

  return `${userId.slice(0, 2)}***${userId.slice(-2)}`;
};

const logError = (userId: string, errorType: LLMServiceErrorType): void => {
  console.error(`[${MODULE_NAME}] user=${maskUserId(userId)} errorType=${errorType}`);
};

const createModel = (): ChatOpenAI => {
  if (!config.openAIApiKey) {
    throw new LLMServiceError("MISSING_API_KEY", "OPENAI_API_KEY is missing");
  }

  try {
    return new ChatOpenAI({
      model: "gpt-3.5-turbo",
      temperature: 0.7,
      openAIApiKey: config.openAIApiKey,
      timeout: 8000,
    });
  } catch (error) {
    throw new LLMServiceError(
      "MODEL_INIT_FAILED",
      "Failed to initialize OpenAI model",
      error,
    );
  }
};

const getOrCreateMemory = (userId: string): BufferMemory => {
  const existingMemory = userMemories.get(userId);

  if (existingMemory) {
    return existingMemory;
  }

  const memory = new BufferMemory({
    memoryKey: "history",
    inputKey: "input",
    outputKey: "response",
    returnMessages: true,
  });

  userMemories.set(userId, memory);

  return memory;
};

const trimMemory = async (memory: BufferMemory): Promise<void> => {
  const messages = await memory.chatHistory.getMessages();

  if (messages.length <= MAX_CONTEXT_MESSAGES) {
    return;
  }

  const recentMessages = messages.slice(-MAX_CONTEXT_MESSAGES);

  await memory.chatHistory.clear();

  for (const msg of recentMessages) {
    await memory.chatHistory.addMessage(msg);
  }
};

export const LLMService = {
  async chat(userId: string, message: string): Promise<string> {
    const memory = getOrCreateMemory(userId);

    try {
      const chain = new ConversationChain({
        llm: createModel(),
        memory,
      });

      const response = await chain.call({ input: message });
      await trimMemory(memory);

      return String(response.response ?? "");
    } catch (error) {
      if (error instanceof LLMServiceError) {
        logError(userId, error.type);
        throw error;
      }

      const wrappedError = new LLMServiceError(
        "MODEL_CALL_FAILED",
        "Failed to generate model response",
        error,
      );

      logError(userId, wrappedError.type);
      throw wrappedError;
    }
  },
};
