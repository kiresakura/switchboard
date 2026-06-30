import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  streamText,
  type UIMessage,
} from "ai";
import { anthropic } from "@ai-sdk/anthropic";

type ProviderName = "anthropic" | "codex";

type ProviderConfig = {
  provider: ProviderName;
  model: string;
};

type CodexCredentials = {
  accessToken: string;
  baseUrl: string;
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
const DEFAULT_CODEX_MODEL = "gpt-5.5";
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_TIMEOUT_MS = 120_000;

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
  if (value === "anthropic" || value === "codex") return value;
  throw new AIProviderConfigError(
    `不支援的 AI provider: ${value}。請設定 LLM_PROVIDER=anthropic 或 codex`,
  );
}

export function resolveProviderConfig(): ProviderConfig {
  const provider = normalizeProvider(process.env.LLM_PROVIDER || process.env.AI_PROVIDER);
  if (!provider) {
    throw new AIProviderConfigError("尚未設定 AI_PROVIDER / LLM_PROVIDER");
  }

  if (provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    throw new AIProviderConfigError("尚未設定 ANTHROPIC_API_KEY");
  }

  return {
    provider,
    model:
      process.env.LLM_MODEL?.trim() ||
      (provider === "codex" ? DEFAULT_CODEX_MODEL : DEFAULT_ANTHROPIC_MODEL),
  };
}

export async function generateProviderText(input: GenerateTextInput): Promise<string> {
  const config = resolveProviderConfig();
  if (config.provider === "anthropic") {
    const { text } = await generateText({
      model: anthropic(config.model),
      system: input.system,
      prompt: input.prompt,
    });
    return text;
  }

  let fullText = "";
  for await (const delta of streamCodexText({
    config,
    inputText: input.prompt,
    instructions: input.system,
  })) {
    fullText += delta;
  }
  return fullText.trim();
}

export async function streamProviderUIMessageResponse(input: StreamTextInput): Promise<Response> {
  const config = resolveProviderConfig();
  if (config.provider === "anthropic") {
    const modelMessages = await convertToModelMessages(input.messages);
    const result = streamText({
      model: anthropic(config.model),
      system: input.system,
      messages: modelMessages,
    });
    return result.toUIMessageStreamResponse();
  }

  const stream = createUIMessageStream<UIMessage>({
    execute: async ({ writer }) => {
      const textPartId = "codex-text";
      writer.write({ type: "start" });
      writer.write({ type: "start-step" });
      writer.write({ type: "text-start", id: textPartId });

      for await (const delta of streamCodexText({
        config,
        instructions: input.system,
        inputText: uiMessagesToCodexInputText(input.messages),
      })) {
        if (delta) writer.write({ type: "text-delta", id: textPartId, delta });
      }

      writer.write({ type: "text-end", id: textPartId });
      writer.write({ type: "finish-step" });
      writer.write({ type: "finish", finishReason: "stop" });
    },
    onError: (error) => {
      if (isAIProviderConfigError(error)) return error.message;
      if (isAIProviderRequestError(error)) return error.message;
      return "AI 服務暫時無法使用";
    },
  });

  return createUIMessageStreamResponse({ stream });
}

function uiMessagesToCodexInputText(messages: UIMessage[]): string {
  const lines = messages
    .map((message) => {
      const text = uiMessageText(message).trim();
      if (!text) return "";
      const role = message.role === "assistant" ? "AI 副駕" : "Operator";
      return `${role}: ${text}`;
    })
    .filter(Boolean);

  return lines.length > 0
    ? `Operator 與 AI 副駕目前的互動如下,請延續最後一則 Operator 訊息回答:\n${lines.join("\n")}`
    : "請根據系統提供的對話脈絡,給 Operator 可直接使用的客服建議。";
}

function uiMessageText(message: UIMessage): string {
  return message.parts
    .map((part) => {
      if (
        part &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .join("");
}

async function* streamCodexText({
  config,
  instructions,
  inputText,
}: {
  config: ProviderConfig;
  instructions: string;
  inputText: string;
}): AsyncGenerator<string> {
  const credentials = await resolveCodexCredentials();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${credentials.baseUrl}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "Content-Type": "application/json",
        session_id: "switchboard-direct-chat-ai",
        "x-client-request-id": "switchboard-direct-chat-ai",
      },
      body: JSON.stringify({
        model: config.model,
        instructions,
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: inputText }],
          },
        ],
        stream: true,
        store: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const message = await safeReadError(response);
      throw new AIProviderRequestError(
        response.status === 429
          ? `Codex 使用量已達上限: ${message}`
          : `Codex Responses API failed (${response.status}): ${message}`,
        response.status,
      );
    }

    const contentType = response.headers.get("content-type") || "";
    if (!response.body) {
      if (contentType.includes("application/json")) {
        const data = (await response.json()) as unknown;
        const text = extractCodexText(data);
        if (text) yield text;
      }
      return;
    }

    if (contentType.includes("application/json")) {
      const data = (await response.json()) as unknown;
      const text = extractCodexText(data);
      if (text) yield text;
      return;
    }

    let fallbackCompletedText = "";
    for await (const event of readSseEvents(response.body)) {
      if (event === "[DONE]") break;
      const data = safeJsonParse(event);
      if (!isRecord(data)) continue;

      const delta = extractCodexDelta(data);
      if (delta) {
        yield delta;
        continue;
      }

      const eventType = objectString(data, "type");
      if (eventType === "response.completed") {
        fallbackCompletedText = extractCodexText(data);
      }
      if (eventType === "response.failed" || eventType === "error") {
        throw new Error(extractCodexError(data) || "Codex Responses API stream failed");
      }
    }

    if (fallbackCompletedText) yield fallbackCompletedText;
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveCodexCredentials(): Promise<CodexCredentials> {
  const envToken = process.env.CODEX_ACCESS_TOKEN?.trim();
  if (envToken) {
    return {
      accessToken: envToken,
      baseUrl: codexBaseUrl(),
    };
  }

  if (process.env.CODEX_TOKEN_BROKER_URL?.trim()) {
    return resolveCodexCredentialsFromBroker();
  }

  const authSource = (process.env.CODEX_AUTH_SOURCE || "hermes").trim().toLowerCase();
  if (authSource !== "hermes") {
    throw new AIProviderConfigError(
      "Codex provider 已啟用,但沒有 CODEX_ACCESS_TOKEN 或 CODEX_TOKEN_BROKER_URL",
    );
  }

  if (
    process.env.NODE_ENV === "production" &&
    process.env.CODEX_ALLOW_HERMES_IN_PRODUCTION !== "true"
  ) {
    throw new AIProviderConfigError(
      "Codex provider 在 production 不可直接讀取 Hermes auth；請設定 CODEX_ACCESS_TOKEN 或 CODEX_TOKEN_BROKER_URL",
    );
  }

  return resolveCodexCredentialsFromHermes();
}

async function resolveCodexCredentialsFromBroker(): Promise<CodexCredentials> {
  const url = process.env.CODEX_TOKEN_BROKER_URL?.trim();
  if (!url) {
    throw new AIProviderConfigError("CODEX_TOKEN_BROKER_URL 未設定");
  }

  const headers: HeadersInit = { "Content-Type": "application/json" };
  const secret = process.env.CODEX_TOKEN_BROKER_SECRET?.trim();
  if (secret) headers.Authorization = `Bearer ${secret}`;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ provider: "codex", purpose: "switchboard-direct-chat-ai" }),
  });
  if (!response.ok) {
    throw new AIProviderConfigError(`Codex token broker 回應失敗 (${response.status})`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const token =
    stringValue(data.access_token) ||
    stringValue(data.api_key) ||
    stringValue(data.token);
  if (!token) {
    throw new AIProviderConfigError("Codex token broker 未回傳 access token");
  }

  return {
    accessToken: token,
    baseUrl: stringValue(data.base_url) || codexBaseUrl(),
  };
}

async function resolveCodexCredentialsFromHermes(): Promise<CodexCredentials> {
  const python = resolveHermesPython();
  const hermesPath = resolveHermesPythonPath();
  const script = [
    "import json",
    "from hermes_cli.auth import resolve_codex_runtime_credentials",
    "creds = resolve_codex_runtime_credentials(refresh_if_expiring=True)",
    "print(json.dumps({'api_key': creds.get('api_key'), 'base_url': creds.get('base_url')}))",
  ].join("\n");

  const result = await runProcess(python, ["-c", script], {
    PYTHONPATH: hermesPath,
  });
  if (result.code !== 0) {
    throw new AIProviderConfigError(
      `無法透過 Hermes 取得 Codex token: ${result.stderr.slice(0, 300) || "unknown error"}`,
    );
  }

  const data = safeJsonParse(result.stdout.trim()) as Record<string, unknown> | null;
  const token = data ? stringValue(data.api_key) : "";
  if (!token) {
    throw new AIProviderConfigError("Hermes resolver 未回傳 Codex access token");
  }

  return {
    accessToken: token,
    baseUrl: data ? stringValue(data.base_url) || codexBaseUrl() : codexBaseUrl(),
  };
}

function resolveHermesPython(): string {
  if (process.env.CODEX_HERMES_PYTHON?.trim()) return process.env.CODEX_HERMES_PYTHON.trim();
  const candidate = `${process.env.HOME || ""}/.hermes/hermes-agent/venv/bin/python`;
  if (candidate && existsSync(candidate)) return candidate;
  return "python3";
}

function resolveHermesPythonPath(): string | undefined {
  if (process.env.CODEX_HERMES_PYTHONPATH?.trim()) return process.env.CODEX_HERMES_PYTHONPATH.trim();
  const candidate = `${process.env.HOME || ""}/.hermes/hermes-agent`;
  if (candidate && existsSync(candidate)) return candidate;
  return process.env.PYTHONPATH;
}

function codexBaseUrl(): string {
  return (process.env.CODEX_BASE_URL || DEFAULT_CODEX_BASE_URL).replace(/\/+$/, "");
}

async function runProcess(
  command: string,
  args: string[],
  envOverrides: Record<string, string | undefined>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        ...Object.fromEntries(
          Object.entries(envOverrides).filter((entry): entry is [string, string] => Boolean(entry[1])),
        ),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: String(error) });
    });
  });
}

async function* readSseEvents(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();
      if (data) yield data;
      boundary = buffer.indexOf("\n\n");
    }
  }

  const rest = buffer.trim();
  if (rest) {
    const data = rest
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (data) yield data;
  }
}

function extractCodexDelta(data: unknown): string {
  if (!isRecord(data)) return "";

  const type = objectString(data, "type");
  if (
    type === "response.output_text.delta" ||
    type === "response.refusal.delta" ||
    type === "response.reasoning_summary_text.delta"
  ) {
    return objectString(data, "delta");
  }

  const delta = data.delta;
  if (typeof delta === "string") return delta;
  if (isRecord(delta)) {
    return objectString(delta, "text") || objectString(delta, "value");
  }

  return "";
}

export function extractCodexText(data: unknown): string {
  if (!isRecord(data)) return "";

  const direct = objectString(data, "output_text");
  if (direct) return direct;

  if (isRecord(data.response)) {
    const nested = extractCodexText(data.response);
    if (nested) return nested;
  }

  const output = data.output;
  if (!Array.isArray(output)) return "";

  const chunks: string[] = [];
  for (const item of output) {
    if (!isRecord(item)) continue;
    const itemText = objectString(item, "text");
    if (itemText) chunks.push(itemText);
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!isRecord(part)) continue;
      const text = objectString(part, "text");
      if (text) chunks.push(text);
    }
  }
  return chunks.join("");
}

function extractCodexError(data: unknown): string {
  if (!isRecord(data)) return "";
  if (isRecord(data.error)) {
    return objectString(data.error, "message") || objectString(data.error, "code");
  }
  return objectString(data, "message") || objectString(data, "error");
}

async function safeReadError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return response.statusText;
  const data = safeJsonParse(text);
  return extractCodexError(data) || text.slice(0, 300);
}

function safeJsonParse(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function objectString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
