import dotenv from "dotenv";

dotenv.config();

type RequiredConfigKey =
  | "LINE_CHANNEL_SECRET"
  | "LINE_CHANNEL_ACCESS_TOKEN";

const DEFAULT_LLM_MODEL = "gpt-3.5-turbo";

export interface AppConfig {
  lineChannelSecret: string;
  lineChannelAccessToken: string;
  llmApiKey?: string;
  llmBaseUrl?: string;
  llmModel: string;
  port: number;
}

const REQUIRED_KEYS: RequiredConfigKey[] = [
  "LINE_CHANNEL_SECRET",
  "LINE_CHANNEL_ACCESS_TOKEN",
];

const getMissingKeys = (): RequiredConfigKey[] => {
  return REQUIRED_KEYS.filter((key) => {
    const value = process.env[key];
    return !value || value.trim().length === 0;
  });
};

const getOptionalEnv = (key: string): string | undefined => {
  const value = process.env[key]?.trim();

  if (!value) {
    return undefined;
  }

  return value;
};

const parsePort = (): number => {
  const rawPort = getOptionalEnv("PORT");

  if (!rawPort) {
    return 3000;
  }

  const parsedPort = Number(rawPort);

  if (Number.isNaN(parsedPort) || parsedPort <= 0 || !Number.isInteger(parsedPort)) {
    throw new Error("Invalid PORT. Please provide a positive integer.");
  }

  return parsedPort;
};

const parseLlmBaseUrl = (): string | undefined => {
  const llmBaseUrl = getOptionalEnv("LLM_BASE_URL");

  if (!llmBaseUrl) {
    return undefined;
  }

  try {
    new URL(llmBaseUrl);
    return llmBaseUrl;
  } catch {
    throw new Error("Invalid LLM_BASE_URL. Please provide a valid URL.");
  }
};

const missingKeys = getMissingKeys();

if (missingKeys.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missingKeys.join(", ")}`,
  );
}

export const config: AppConfig = {
  lineChannelSecret: process.env.LINE_CHANNEL_SECRET as string,
  lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN as string,
  llmApiKey: getOptionalEnv("LLM_API_KEY"),
  llmBaseUrl: parseLlmBaseUrl(),
  llmModel: getOptionalEnv("LLM_MODEL") ?? DEFAULT_LLM_MODEL,
  port: parsePort(),
};
