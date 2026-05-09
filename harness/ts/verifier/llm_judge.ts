// LLM judge fallback. Used only when a task is tagged `judge_required` AND
// declares verifier.kind=llm_judge.
//
// Sampling: temperature=0, three independent calls, majority vote.
//   - Three calls (rather than the API's `n=` parameter) keeps the contract
//     identical across providers and ensures every response lands in the
//     trajectory + replay cache.
//   - Each call uses a distinct paradigm_seed ("judge:0", ":1", ":2") so the
//     three responses produce independent cache entries; a future tournament
//     re-run replays all three deterministically.
//   - Each call asks the model to answer with a single token "PASS" or
//     "FAIL" so parsing is unambiguous.
//
// The aggregate verdict is the majority over the three votes; ties (impossible
// with n=3 but defended for n>=4 future) fall back to FAIL.

import {
  VerifierMisuseError,
  type LlmJudgeSpec,
  type Task,
  type Verdict,
  type Verifier,
  type VerifyContext,
} from "./types.js";

const DEFAULT_MODEL = "gpt-4o";
const N_VOTES = 3;
const PROMPT_TEMPLATE = (
  task: Task,
  spec: LlmJudgeSpec,
  finalUrl: string,
  trajectorySummary: string,
): string => `You are an impartial judge for a browser-agent task.

Task id: ${task.id}
Goal: ${task.goal}
Start URL: ${task.start_url}
Final URL: ${finalUrl}

Trajectory summary (most-recent last):
${trajectorySummary}

Question: ${spec.question}
${spec.expected ? `Expected answer (for reference): ${spec.expected}\n` : ""}
Respond with exactly one token: PASS if the agent succeeded, FAIL otherwise.
Do not include any other text.`;

export class LlmJudgeVerifier implements Verifier {
  readonly kind = "llm_judge" as const;
  constructor(private readonly spec: LlmJudgeSpec) {}

  async verify(task: Task, ctx: VerifyContext): Promise<Verdict> {
    if (!ctx.llm) {
      throw new VerifierMisuseError("LlmJudgeVerifier requires ctx.llm");
    }
    const finalUrl = await currentUrl(ctx);
    const summary = trajectorySummary(ctx);
    const model = this.spec.model ?? DEFAULT_MODEL;
    const prompt = PROMPT_TEMPLATE(task, this.spec, finalUrl, summary);

    const votes: Array<"PASS" | "FAIL" | "?"> = [];
    const reasons: string[] = [];
    for (let i = 0; i < N_VOTES; i++) {
      const r = await ctx.llm.call(
        model,
        [{ role: "user", content: prompt }],
        { temperature: 0, paradigm_seed: `judge:${i}` },
      );
      const norm = normaliseVote(r.text);
      votes.push(norm);
      reasons.push(`vote ${i + 1}: ${norm} (raw=${truncate(r.text, 60)})`);
    }
    const passCount = votes.filter((v) => v === "PASS").length;
    const failCount = votes.filter((v) => v === "FAIL").length;
    const pass = passCount > failCount;
    return {
      pass,
      score: passCount / votes.length,
      reason: `llm_judge majority ${passCount}/${votes.length} PASS — ${reasons.join("; ")}`,
    };
  }
}

function normaliseVote(text: string): "PASS" | "FAIL" | "?" {
  const t = text.trim().toUpperCase();
  if (t.startsWith("PASS")) return "PASS";
  if (t.startsWith("FAIL")) return "FAIL";
  // Tolerate "yes"/"no" as a soft fallback.
  if (t === "YES" || t === "TRUE") return "PASS";
  if (t === "NO" || t === "FALSE") return "FAIL";
  return "?";
}

async function currentUrl(ctx: VerifyContext): Promise<string> {
  if (!ctx.browser) return "<no browser>";
  try {
    return await ctx.browser.evaluate<string>("window.location.href");
  } catch {
    return "<unknown>";
  }
}

function trajectorySummary(ctx: VerifyContext): string {
  if (!ctx.trajectory) return "(no trajectory)";
  const steps = ctx.trajectory.snapshotSteps();
  if (steps.length === 0) return "(no steps)";
  const tail = steps.slice(-8); // most-recent eight is enough for a judge.
  return tail
    .map((s) => `step ${s.step}: ${s.action.type} — ${truncate(s.observation_summary, 120)}`)
    .join("\n");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
