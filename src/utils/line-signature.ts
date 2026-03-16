import crypto from "crypto";

export interface GenerateLineSignatureOptions {
  channelSecret: string;
  body: string;
}

export function generateLineSignature(
  options: GenerateLineSignatureOptions,
): string {
  return crypto
    .createHmac("sha256", options.channelSecret)
    .update(options.body, "utf8")
    .digest("base64");
}
