// Gemini generateContent provider.
//
// Endpoint: POST {baseUrl}/models/{model}:generateContent?key=API_KEY
// Gemini puts the API key in the query string, which means a raw fetch error
// could leak it. The LLMClient applies redaction to error messages at its
// boundary — providers are expected to throw plain Errors and let the client
// scrub before they reach trajectory or stderr.
//
// Role mapping: OpenAI-style {system, user, assistant} → Gemini's
// systemInstruction (concatenated) + contents[{role: "user"|"model", parts}].

import type {
  LLMProvider,
  ProviderRequest,
  ProviderResponse,
} from "../types.js";

interface GenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
}

export interface GeminiProviderOpts {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GeminiProviderOpts) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async call(req: ProviderRequest): Promise<ProviderResponse> {
    const systemMsgs = req.messages.filter((m) => m.role === "system").map((m) => m.content);
    const turn = req.messages.filter((m) => m.role !== "system");

    const contents = turn.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const body: Record<string, unknown> = { contents };
    if (systemMsgs.length) {
      body.systemInstruction = { parts: [{ text: systemMsgs.join("\n\n") }] };
    }
    const generationConfig: Record<string, unknown> = {};
    if (req.opts.temperature !== undefined) generationConfig.temperature = req.opts.temperature;
    if (req.opts.max_tokens !== undefined) generationConfig.maxOutputTokens = req.opts.max_tokens;
    if (req.opts.stop) generationConfig.stopSequences = req.opts.stop;
    if (req.opts.json_mode) generationConfig.responseMimeType = "application/json";
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;

    const url =
      `${this.baseUrl}/models/${encodeURIComponent(req.model)}:generateContent` +
      `?key=${encodeURIComponent(this.apiKey)}`;
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Gemini ${res.status}: ${text.slice(0, 1024)}`);
    }
    let json: GenerateContentResponse;
    try {
      json = JSON.parse(text) as GenerateContentResponse;
    } catch (e) {
      throw new Error(`Gemini returned non-JSON: ${(e as Error).message}`);
    }
    if (json.error?.message) throw new Error(`Gemini error: ${json.error.message}`);
    const out = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    return {
      text: out,
      tokens_in: json.usageMetadata?.promptTokenCount ?? 0,
      tokens_out: json.usageMetadata?.candidatesTokenCount ?? 0,
    };
  }
}
