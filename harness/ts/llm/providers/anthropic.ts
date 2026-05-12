// Anthropic Messages API provider.
//
// Endpoint: POST {baseUrl}/messages
// Headers: x-api-key, anthropic-version. The API key never appears in the
// URL or body, so the only redaction risk is whatever the API itself echoes
// back in an error body — LLMClient handles that at its boundary.
//
// Role mapping: OpenAI-style {system, user, assistant} →
//   - system: concatenated into the top-level `system` field
//   - user/assistant: passed through as messages
// Anthropic does NOT accept a `tool` role at this layer; the harness has no
// tool-call flow today, so we surface a clear error if one slips in.
//
// Multimodal: the harness uses OpenAI's content-part shape
//   { type: "text", text } / { type: "image_url", image_url: { url } }
// Anthropic wants { type: "text", text } / { type: "image", source }. We
// translate `image_url` → Anthropic image (base64 if data: URL, else url).

import type {
  LLMContentPart,
  LLMMessage,
  LLMProvider,
  ProviderRequest,
  ProviderResponse,
} from "../types.js";

interface AnthropicMessagesResponse {
  content?: { type?: string; text?: string }[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string; type?: string };
  type?: string;
}

export interface AnthropicProviderOpts {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Anthropic API version header. Default "2023-06-01" (current stable). */
  anthropicVersion?: string;
  /**
   * Default max_tokens when the caller does not specify one. Anthropic
   * requires this field. OpenAI doesn't, so the harness commonly omits it.
   */
  defaultMaxTokens?: number;
  /**
   * Max retry attempts on transient errors (429 + 5xx). Default 5.
   * Mirrors OpenAiProvider's strategy: honour Retry-After header, parse
   * "try again in Xms" hints, fall back to exponential backoff.
   */
  maxRetries?: number;
  /** Override the wait function. Tests inject a no-op. */
  sleep?: (ms: number) => Promise<void>;
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly anthropicVersion: string;
  private readonly defaultMaxTokens: number;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: AnthropicProviderOpts) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.anthropic.com/v1";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.anthropicVersion = opts.anthropicVersion ?? "2023-06-01";
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 4096;
    this.maxRetries = opts.maxRetries ?? 5;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async call(req: ProviderRequest): Promise<ProviderResponse> {
    const systemParts: string[] = [];
    const turn: LLMMessage[] = [];
    for (const m of req.messages) {
      if (m.role === "system") {
        if (typeof m.content !== "string") {
          throw new Error("Anthropic provider: system messages must be plain strings");
        }
        systemParts.push(m.content);
      } else if (m.role === "tool") {
        throw new Error("Anthropic provider: 'tool' role messages are not supported");
      } else {
        turn.push(m);
      }
    }

    const messages = turn.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: encodeContent(m.content),
    }));

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.opts.max_tokens ?? this.defaultMaxTokens,
      messages,
    };
    if (systemParts.length) body.system = systemParts.join("\n\n");
    if (req.opts.temperature !== undefined) body.temperature = req.opts.temperature;
    if (req.opts.stop) body.stop_sequences = req.opts.stop;
    // Anthropic has no "json_mode" toggle. The convention is to ask for JSON
    // in the prompt. We silently drop json_mode here; the cache key still
    // captures the caller's intent so a swap back to OpenAI re-keys.

    let lastErr = "";
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const res = await this.fetchImpl(`${this.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": this.anthropicVersion,
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        const transient = res.status === 429 || (res.status >= 500 && res.status < 600);
        lastErr = `Anthropic ${res.status}: ${text.slice(0, 1024)}`;
        if (transient && attempt < this.maxRetries) {
          const headerWait = parseRetryAfterMs(res.headers.get("retry-after"));
          const bodyWait = parseTryAgainHintMs(text);
          const backoff = Math.min(30_000, 500 * Math.pow(2, attempt));
          const waitMs = Math.max(headerWait ?? 0, bodyWait ?? 0, backoff);
          await this.sleep(waitMs);
          continue;
        }
        throw new Error(lastErr);
      }
      let json: AnthropicMessagesResponse;
      try {
        json = JSON.parse(text) as AnthropicMessagesResponse;
      } catch (e) {
        throw new Error(`Anthropic returned non-JSON: ${(e as Error).message}`);
      }
      if (json.error?.message) {
        throw new Error(`Anthropic error: ${json.error.message}`);
      }
      const out =
        json.content
          ?.filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("") ?? "";
      return {
        text: out,
        tokens_in: json.usage?.input_tokens ?? 0,
        tokens_out: json.usage?.output_tokens ?? 0,
      };
    }
    throw new Error(lastErr || "Anthropic: exhausted retries with no response");
  }
}

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source:
        | { type: "base64"; media_type: string; data: string }
        | { type: "url"; url: string };
    };

function encodeContent(
  content: string | LLMContentPart[],
): string | AnthropicContentBlock[] {
  if (typeof content === "string") return content;
  return content.map((part): AnthropicContentBlock => {
    if (part.type === "text") return { type: "text", text: part.text };
    const url = part.image_url.url;
    const dataMatch = /^data:([^;,]+);base64,(.+)$/.exec(url);
    if (dataMatch) {
      return {
        type: "image",
        source: { type: "base64", media_type: dataMatch[1]!, data: dataMatch[2]! },
      };
    }
    return { type: "image", source: { type: "url", url } };
  });
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const n = Number(header);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.floor(n * 1000));
}

function parseTryAgainHintMs(body: string): number | null {
  const ms = body.match(/try again in (\d+)\s*ms/i);
  if (ms?.[1]) return Number(ms[1]);
  const sec = body.match(/try again in ([\d.]+)\s*s/i);
  if (sec?.[1]) {
    const n = Number(sec[1]);
    if (Number.isFinite(n)) return Math.floor(n * 1000);
  }
  return null;
}
