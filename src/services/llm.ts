import { ChatOpenAI } from "@langchain/openai";
import {
  AIMessage,
  HumanMessage,
  type BaseMessage,
} from "@langchain/core/messages";

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

const userMemories = new Map<string, BaseMessage[]>();

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
  if (!config.llmApiKey) {
    throw new LLMServiceError("MISSING_API_KEY", "LLM_API_KEY is missing");
  }

  try {
    return new ChatOpenAI({
      model: config.llmModel,
      temperature: 0.7,
      apiKey: config.llmApiKey,
      timeout: 8000,
      configuration: config.llmBaseUrl
        ? {
            baseURL: config.llmBaseUrl,
          }
        : undefined,
    });
  } catch (error) {
    throw new LLMServiceError(
      "MODEL_INIT_FAILED",
      "Failed to initialize OpenAI model",
      error,
    );
  }
};

const getOrCreateHistory = (userId: string): BaseMessage[] => {
  const existingHistory = userMemories.get(userId);

  if (existingHistory) {
    return existingHistory;
  }

  const history: BaseMessage[] = [];
  userMemories.set(userId, history);

  return history;
};

const trimHistory = (messages: BaseMessage[]): BaseMessage[] => {
  if (messages.length <= MAX_CONTEXT_MESSAGES) {
    return messages;
  }

  return messages.slice(-MAX_CONTEXT_MESSAGES);
};

const buildRequestMessages = (
  history: BaseMessage[],
  message: string,
): BaseMessage[] => {
  return [...history, new HumanMessage(message)];
};

const extractTextFromContentPart = (part: unknown): string => {
  if (typeof part === "string") {
    return part;
  }

  if (!part || typeof part !== "object") {
    return "";
  }

  if ("text" in part && typeof part.text === "string") {
    return part.text;
  }

  return "";
};

const normalizeResponseText = (content: unknown): string => {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content.map(extractTextFromContentPart).join("").trim();
  }

  return "";
};

export const LLMService = {
  async chat(userId: string, message: string): Promise<string> {
    const history = getOrCreateHistory(userId);
    const requestMessages = buildRequestMessages(history, message);

    try {
      const response = await createModel().invoke(requestMessages);
      const responseText = normalizeResponseText(response.content);
      const nextHistory = trimHistory([
        ...requestMessages,
        new AIMessage(responseText),
      ]);

      userMemories.set(userId, nextHistory);

      return responseText;
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
