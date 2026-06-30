import {
  convertToModelMessages,
  generateText,
  streamText,
  type UIMessage,
} from "ai";
import { anthropic } from "@ai-sdk/anthropic";

type ProviderName = "anthropic";

type ProviderConfig = {
  provider: ProviderName;
  model: string;
};

type GenerateTextInput = {
  system: string;
  prompt: string;
};

type StreamTextInput = {
  system: string;
  messages: UIMessage[];
};

const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5";

export class AIProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AIProviderConfigError";
  }
}

export class AIProviderRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AIProviderRequestError";
  }
}

export function isAIProviderConfigError(error: unknown): error is AIProviderConfigError {
  return error instanceof AIProviderConfigError;
}

export function isAIProviderRequestError(error: unknown): error is AIProviderRequestError {
  return error instanceof AIProviderRequestError;
}

function normalizeProvider(raw: string | undefined): ProviderName | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (value === "anthropic") return value;
  throw new AIProviderConfigError(
    `不支援的 AI provider: ${value}。請設定 LLM_PROVIDER=anthropic`,
  );
}

export function resolveProviderConfig(): ProviderConfig {
  const provider = normalizeProvider(process.env.LLM_PROVIDER || process.env.AI_PROVIDER);
  if (!provider) {
    throw new AIProviderConfigError("尚未設定 AI_PROVIDER / LLM_PROVIDER");
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new AIProviderConfigError("尚未設定 ANTHROPIC_API_KEY");
  }
  return {
    provider,
    model: process.env.LLM_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL,
  };
}

export async function generateProviderText(input: GenerateTextInput): Promise<string> {
  const config = resolveProviderConfig();
  const { text } = await generateText({
    model: anthropic(config.model),
    system: input.system,
    prompt: input.prompt,
  });
  return text;
}

export async function streamProviderUIMessageResponse(input: StreamTextInput): Promise<Response> {
  const config = resolveProviderConfig();
  const modelMessages = await convertToModelMessages(input.messages);
  const result = streamText({
    model: anthropic(config.model),
    system: input.system,
    messages: modelMessages,
  });
  return result.toUIMessageStreamResponse();
}
