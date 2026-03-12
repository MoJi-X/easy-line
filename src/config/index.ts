import dotenv from "dotenv";

dotenv.config();

type RequiredConfigKey =
  | "LINE_CHANNEL_SECRET"
  | "LINE_CHANNEL_ACCESS_TOKEN";

interface AppConfig {
  lineChannelSecret: string;
  lineChannelAccessToken: string;
  openAIApiKey?: string;
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

const parsePort = (): number => {
  const rawPort = process.env.PORT?.trim();

  if (!rawPort) {
    return 3000;
  }

  const parsedPort = Number(rawPort);

  if (Number.isNaN(parsedPort) || parsedPort <= 0 || !Number.isInteger(parsedPort)) {
    throw new Error("Invalid PORT. Please provide a positive integer.");
  }

  return parsedPort;
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
  openAIApiKey: process.env.OPENAI_API_KEY?.trim() || undefined,
  port: parsePort(),
};
