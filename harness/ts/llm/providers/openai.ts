// OpenAI Chat Completions provider.
//
// Endpoint: POST {baseUrl}/chat/completions
// We send the messages array verbatim; the API accepts {role, content}
// objects directly. Auth via the Authorization header so the key never
// appears in the URL.
//
// We accept a `fetchImpl` injection point for tests so no network is
// required. Production callers fall back to the global fetch.

import type {
  LLMProvider,
  ProviderRequest,
  ProviderResponse,
} from "../types.js";

interface ChatCompletionsResponse {
  choices?: { message?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export interface OpenAiProviderOpts {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /**
   * Max retry attempts on transient errors (429 + 5xx). Default 5.
   * Each retry waits per-Retry-After (or a parsed "try again in Xms" hint),
   * falling back to exponential backoff (500ms × 2^attempt, capped at 30s).
   * Five retries gives a worst-case wait of 500+1000+2000+4000+8000 = 15.5s,
   * which is enough to clear most TPM rate-limit windows.
   */
  maxRetries?: number;
  /** Override the wait function. Tests inject a no-op here. */
  sleep?: (ms: number) => Promise<void>;
}

export class OpenAiProvider implements LLMProvider {
  readonly name = "openai" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: OpenAiProviderOpts) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxRetries = opts.maxRetries ?? 5;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async call(req: ProviderRequest): Promise<ProviderResponse> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
    };
    if (req.opts.temperature !== undefined) body.temperature = req.opts.temperature;
    if (req.opts.max_tokens !== undefined) body.max_tokens = req.opts.max_tokens;
    if (req.opts.stop) body.stop = req.opts.stop;
    if (req.opts.json_mode) body.response_format = { type: "json_object" };

    let lastErr = "";
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        const transient = res.status === 429 || (res.status >= 500 && res.status < 600);
        lastErr = `OpenAI ${res.status}: ${text.slice(0, 1024)}`;
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
      let json: ChatCompletionsResponse;
      try {
        json = JSON.parse(text) as ChatCompletionsResponse;
      } catch (e) {
        throw new Error(`OpenAI returned non-JSON: ${(e as Error).message}`);
      }
      if (json.error?.message) throw new Error(`OpenAI error: ${json.error.message}`);
      return {
        text: json.choices?.[0]?.message?.content ?? "",
        tokens_in: json.usage?.prompt_tokens ?? 0,
        tokens_out: json.usage?.completion_tokens ?? 0,
      };
    }
    throw new Error(lastErr || "OpenAI: exhausted retries with no response");
  }
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  // Spec allows seconds (integer) or HTTP-date; OpenAI uses seconds.
  const n = Number(header);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.floor(n * 1000));
}

function parseTryAgainHintMs(body: string): number | null {
  // OpenAI's 429 body usually contains "Please try again in 455ms." or
  // "Please try again in 1.2s.". Parse whichever form we find.
  const ms = body.match(/try again in (\d+)\s*ms/i);
  if (ms?.[1]) return Number(ms[1]);
  const sec = body.match(/try again in ([\d.]+)\s*s/i);
  if (sec?.[1]) {
    const n = Number(sec[1]);
    if (Number.isFinite(n)) return Math.floor(n * 1000);
  }
  return null;
}
