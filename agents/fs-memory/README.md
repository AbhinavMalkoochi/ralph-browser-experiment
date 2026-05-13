# fs-memory

US-021, twelfth novel agent slot. **Filesystem-as-working-memory** — the
LLM's working memory is an actual on-disk directory, not the prompt
context window.

## Mechanism

Each turn the prompt is constant-shape:

```
Goal: <task>
Step <N>
URL: <current url>
Title: <current title>

scratch/ tree:
plan.md (412B)
observations/turn-03.md (1.1kB)
notes.md (88B)

Last action result:
ok: read plan.md
--- last action output ---
<contents of plan.md, capped 600 chars>
--- end output ---

Emit ONE JSON action.
```

There is **no rolling observation history**. Whatever browser.observe
returned two turns ago is gone unless the LLM persisted it to disk. The
prompt's shape and size does not grow with the step count.

Action vocabulary (one JSON object per turn):

| Family | Actions |
| --- | --- |
| Filesystem | `fs.write`, `fs.append`, `fs.read`, `fs.list`, `fs.delete` |
| Browser | `browser.observe[selector?]`, `browser.click`, `browser.type`, `browser.navigate`, `browser.scroll`, `browser.wait` |
| Terminate | `done`, `decline` |

All paths are resolved relative to `<trajectoryDir>/scratch/`. Absolute
paths, `..` traversal, drive prefixes, null bytes, and paths over 200
characters are rejected by `ScratchFs.resolve()`. Each file is capped at
32KB; reads are surfaced to the LLM at 4KB.

## Why this is the novel axis

Every prior agent stores rolling history in the prompt:

| Agent | Observation memory |
| --- | --- |
| baseline-a11y-react | last 6 action results (HISTORY_LIMIT=6) |
| plan-then-execute | upfront plan + post-hoc repair plan |
| runtime-codegen | last ~4 script excerpts in prompt |
| speculative-rollback | last action label + state digest |
| predicate-driven | last action result in prompt |
| vision-grounded / vision-som | screenshot + last-action banner |
| network-shadow | last 12 network log entries |
| dom-mutation-stream | last 24 mutation entries |
| dom-shell | last 6 shell commands + results |
| codegen-predicate | last ~4 script excerpts |

`fs-memory` is the only one whose memory is **out-of-band and curated
by the LLM**. The prompt is constant-shape. The trade-off: the agent
pays a per-turn `fs.read` to recall and is forced to summarise (no more
than the file cap fits). The win zone: long flows where context-window
bloat hurts more than the read tax, and tasks where the LLM benefits
from explicitly structuring its notes (e.g. tracking multiple form
fields, multi-page extraction).

## Failure traces that motivated this

Mined from `runs/*/*/0/trajectory.jsonl.gz`:

1. **baseline-a11y-react / hard-modal-stack**: by step 8 the prompt
   carries ~6 stale observations of "modal still open" because each
   `wait` action's result gets folded into HISTORY. The LLM
   re-confirms a stale snapshot rather than re-observing.
2. **runtime-codegen / hard-conditional-form**: prompt grows linearly
   with script excerpts; by step 12 we're at ~3k tokens of historical
   bodies even when most are no-ops.
3. **dom-shell / hard-recoverable**: the agent forgets the failure
   banner appeared on step 2 by step 7 because HISTORY_LIMIT=6 has
   evicted it; an on-disk note ("retry triggers a banner; click again
   after the banner appears") would have survived.

## Distinct from each prior slot

| Prior agent | What's different here |
| --- | --- |
| baseline-a11y-react | no aid table in prompt; named CSS selectors; fs.read replaces HISTORY |
| plan-then-execute | no batch plan; the plan IS `plan.md` on disk |
| runtime-codegen | named actions vs raw JS bodies |
| speculative-rollback | no judge LLM; single LLM call per step |
| predicate-driven | no upfront predicate synthesis; termination via `done` |
| vision-grounded / vision-som | DOM-text observation, not pixels/marks |
| network-shadow | DOM/text observation, not HTTP traffic |
| dom-mutation-stream | snapshot observation, not mutation deltas |
| dom-shell | named JSON actions vs shell-style command line; cwd is in `plan.md`, not in agent state |
| codegen-predicate | named actions vs raw JS bodies; no predicate |

`approach_keywords` Jaccard < 0.5 against every prior agent (asserted in
the test suite — see `fs_memory_agent.test.ts`'s "manifest distinctness"
block).

## Origin

**Ralph-original** mechanism inspired by Karpathy's externalised
scratchpad framing, repurposed for browser tasks. The PRD's
`steeringNotes.preferredDirections` lists "Filesystem-as-working-memory"
as a preferred direction for the open slot; this is a literal
implementation of that.

## Live results

Live eval (`make eval AGENT=fs-memory SLICE=easy SEEDS=1`) is deferred to
a later iteration: this Ralph environment has no LLM API keys configured.
The mechanism is verified end-to-end on real Chrome via the test suite
(scripted-LLM driving fs.write → browser.observe → browser.click →
fs.append → done across multiple steps; cwd-scoped observe; path-escape
rejection; replay-miss / no-provider declines).

## Implementation notes

- `agents/fs-memory/scratch.ts` is the only filesystem touchpoint. All
  path operations go through `ScratchFs.resolve()` which rejects
  traversal/absolute/null-byte paths. The class also enforces a 32KB
  per-file cap so a runaway agent cannot fill the harness disk.
- `agents/fs-memory/actions.ts` parses the LLM's JSON object,
  tolerating ```json fences, leading prose, and a small alias table
  (`write`→`fs.write`, `ls`→`fs.list`, etc.) so the LLM doesn't lose
  a turn to a near-miss action type.
- `agents/fs-memory/agent.ts` keeps the prompt at exactly:
  `goal + banner + scratch tree + last result`. No rolling history.
- `browser.observe` produces both a one-line `summary` (count of
  interactive elements + text length) AND a `body` (the actual element
  list + page text). The body is shown ONCE in the next prompt and
  must be persisted by the agent if it's needed beyond that.
- Terminal states match the harness contract: `DONE`, `DECLINED`,
  `BUDGET_EXCEEDED`, `SESSION_TIMEOUT`, `ERROR`. LLM provider absence
  or replay miss declines cleanly so the contract test passes without
  API keys.
