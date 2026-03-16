import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { generateLineSignature } from "../utils/line-signature";

dotenv.config();

interface CliOptions {
  body?: string;
  file?: string;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const channelSecret = process.env.LINE_CHANNEL_SECRET;

  if (!channelSecret) {
    throw new Error("Missing LINE channel secret in .env. Please set LINE_CHANNEL_SECRET.");
  }

  const body = resolveBody(options);
  const signature = generateLineSignature({
    channelSecret,
    body,
  });

  console.log("X-Line-Signature:", signature);
  console.log("Body-Length:", Buffer.byteLength(body, "utf8"));
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {};
  const positionalArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (!current.startsWith("--")) {
      positionalArgs.push(current);
      continue;
    }

    const [flag, inlineValue] = current.split("=", 2);
    const next = inlineValue ?? args[index + 1];

    if (!next) {
      throw new Error(`Missing value for argument: ${flag}`);
    }

    if (flag === "--body") {
      options.body = next;
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }

    if (flag === "--file") {
      options.file = next;
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }

    throw new Error(`Unsupported argument: ${flag}`);
  }

  if (positionalArgs.length > 1) {
    throw new Error(
      `Unsupported positional arguments: ${positionalArgs.slice(1).join(", ")}`,
    );
  }

  if (options.body === undefined && options.file === undefined && positionalArgs.length === 1) {
    options.file = positionalArgs[0];
  }

  return options;
}

function resolveBody(options: CliOptions): string {
  if (options.body !== undefined && options.file !== undefined) {
    throw new Error("Use either --body or --file, not both.");
  }

  if (options.body !== undefined) {
    return options.body;
  }

  if (options.file !== undefined) {
    const filePath = path.resolve(process.cwd(), options.file);
    return fs.readFileSync(filePath, "utf8");
  }

  throw new Error("Missing request body. Use --body or --file.");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Failed to generate LINE webhook signature:", message);
  process.exit(1);
}
