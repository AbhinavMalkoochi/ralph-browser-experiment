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
}

export class OpenAiProvider implements LLMProvider {
  readonly name = "openai" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAiProviderOpts) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
    this.fetchImpl = opts.fetchImpl ?? fetch;
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
      // Surface the API error body but redact happens upstream in LLMClient.
      throw new Error(`OpenAI ${res.status}: ${text.slice(0, 1024)}`);
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
}
