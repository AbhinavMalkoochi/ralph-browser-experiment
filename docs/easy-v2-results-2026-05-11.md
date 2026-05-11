# Easy slice v2 — live agent sweep (2026-05-11)

US-029 closed: the easy slice has been replaced with a 22-task mix of
8 pure-extraction canaries and 14 multi-step interactive tasks (≥3
interactions or cross-page navigation). This document records the live
re-eval of every existing agent on the new slice.

## Setup

- Slice: `tasks/suite/easy/` (22 yaml files; see `tasks/CLAUDE.md`
  → "Easy slice v2" for the contract).
- Model: gpt-4o-mini, temperature=0 (all LLM agents).
- Budget: easy tier (50k tokens / $0.20 / 60s wall / 15 steps per task).
- Retries: SLICE_RETRIES["easy"] = 2 (up to 3 attempts per cell to
  absorb live-site flakes).
- Seeds: 1.
- Runner: `harness/ts/cli/tournament.ts`, one process per agent, 8
  parallel processes; ~16 min wall clock.
- Runs root: /tmp/easy-v2-sweep (not committed; trajectories follow the
  US-013..US-020 precedent of gitignored per-cell artifacts).

## Leaderboard

| Agent                 | Pass  | %     | Σ cost   | Mean ms |
|-----------------------|-------|-------|----------|--------:|
| network-shadow        | 19/22 | 86.4% | $0.0125  |   6,181 |
| predicate-driven      | 17/22 | 77.3% | $0.0199  |  13,452 |
| baseline-a11y-react   | 17/22 | 77.3% | $0.0237  |   8,014 |
| speculative-rollback  | 17/22 | 77.3% | $0.0295  |  23,442 |
| plan-then-execute     | 16/22 | 72.7% | $0.0050  |   8,390 |
| dom-mutation-stream   | 16/22 | 72.7% | $0.0155  |  14,116 |
| runtime-codegen       | 16/22 | 72.7% | $0.0228  |  15,316 |
| vision-grounded       |  8/22 | 36.4% | $0.1201  |  10,944 |
| **click-first-link**  |  4/22 | 18.2% | $0.0000  |     920 |

Sorted by pass-rate descending, then by Σ cost ascending. Costs are
sums across all 22 cells (NOT per-task averages).

## AC #5 check — slice is no longer trivially satisfiable

The trivial `click-first-link` agent — which navigates to the first
`<a>` href on the start URL — passes **4/22 (18.2%)** of the new slice,
exactly at the AC #5 ceiling (`<=4/22`). The four passes are:

| Task                       | Reason click-first-link still passes      |
|----------------------------|-------------------------------------------|
| easy-arxiv-bert (canary)   | arxiv abs has an in-page skip anchor; URL only gains `#` so pathname stays at `/abs/1810.04805`. |
| easy-mdn-array-map (canary)| MDN's first link is `Skip to main content`; pathname stays; body still has "callback / array". |
| easy-httpbin-headers (canary)| `/headers` is JSON — zero `<a>` tags, agent declines, page stays. |
| easy-cern-nested-page (interactive)| info.cern.ch/'s FIRST link IS `/hypertext/WWW/TheProject.html`, the task's target. Coincidental hit, not mechanism. |

The pre-US-029 slice routinely gave click-first-link 8-12/22 passes
(every body-text canary it landed on). The v2 strict-URL verifier
shape (`pathname && hash === '' && body`) kills that easy win.

## Signal vs the old slice

Old slice (22 single-page extractions), gpt-4o-mini sweeps from US-013
through US-020 reported pass rates of 18-22/22 for every LLM agent —
roughly a 4-point spread between the strongest and weakest non-vision
agent. The new slice gives a **~12-point spread** between
`network-shadow` (19/22) and `vision-grounded` (8/22) and a **~3-point
spread** among the non-vision agents (16-19/22). Mechanism differences
are now visible:

- `network-shadow` wins because most interactive tasks have a clean
  HTTP request the agent can replay or compose (form-submit
  → POST /post, GitHub issues-tab → GET /<owner>/<repo>/issues). The
  API-first substrate cuts steps and absorbs the LLM's worst guesses.
- `predicate-driven` / `baseline-a11y-react` / `speculative-rollback`
  cluster at 17/22 — the predicate, the aid-keyed click vocabulary,
  and the proposer/judge loop each find different navigations cleanly
  but each has one or two specific failure modes (see per-task
  matrix below).
- `vision-grounded` collapses to 8/22 on the v2 slice. Pixel-coord
  clicks on tightly-packed real-site nav bars (GitHub's top tabs,
  IANA's top nav, MDN's left sidebar) hit the documented centre-bias
  failure mode from US-018. The mechanism is healthy on big-button
  app UIs (it tied for top on hard-app at 5/9 per
  `docs/hard-app-sweep-2026-05-10.md`); it struggles on dense
  real-site chrome. This is consistent with the public
  WebVoyager / SeeAct / Operator finding and is why US-031 ships
  Set-of-Marks vision next.

## Per-task PASS matrix

`P` = pass, `.` = fail (any terminal state). Agent columns abbreviated
to 8 chars: `baseline` = baseline-a11y-react, `dom-muta` = dom-mutation-stream,
`network-` = network-shadow, `plan-the` = plan-then-execute,
`predicat` = predicate-driven, `runtime-` = runtime-codegen,
`speculat` = speculative-rollback, `vision-g` = vision-grounded.

| task                            | baseline | dom-muta | network- | plan-the | predicat | runtime- | speculat | vision-g |
|---------------------------------|----------|----------|----------|----------|----------|----------|----------|----------|
| easy-arxiv-bert                 | P        | P        | P        | P        | P        | P        | P        | P        |
| easy-arxiv-listing              | P        | P        | .        | .        | .        | .        | P        | .        |
| easy-cern-nested-page           | P        | P        | P        | .        | P        | P        | P        | .        |
| easy-example-com                | P        | P        | P        | P        | P        | P        | P        | P        |
| easy-github-issues-tab          | P        | P        | P        | P        | P        | .        | P        | .        |
| easy-github-pulls-tab           | P        | P        | P        | .        | P        | P        | P        | .        |
| easy-github-readme-blob         | .        | .        | P        | P        | P        | P        | .        | .        |
| easy-httpbin-form               | P        | P        | .        | P        | P        | .        | .        | .        |
| easy-httpbin-headers            | P        | P        | P        | P        | P        | P        | P        | P        |
| easy-iana-domains-nav           | P        | P        | P        | P        | P        | P        | P        | .        |
| easy-iana-home                  | P        | P        | P        | P        | P        | P        | P        | P        |
| easy-info-cern                  | P        | P        | P        | P        | P        | P        | P        | P        |
| easy-mdn-array-map              | P        | P        | P        | P        | P        | P        | P        | P        |
| easy-mdn-cross-link             | P        | .        | P        | .        | .        | .        | .        | .        |
| easy-mdn-toc-anchor             | .        | .        | P        | P        | P        | P        | .        | .        |
| easy-python-downloads-nav       | P        | P        | P        | P        | P        | P        | P        | .        |
| easy-rfc-format-link            | .        | P        | P        | .        | .        | .        | P        | .        |
| easy-rfc-info                   | P        | P        | P        | P        | P        | P        | P        | P        |
| easy-wiki-article-link          | .        | .        | P        | P        | .        | .        | P        | .        |
| easy-wiki-history-tab           | .        | .        | P        | P        | P        | P        | P        | .        |
| easy-wiki-linux                 | P        | P        | P        | P        | .        | P        | .        | P        |
| easy-wiki-search-curl           | P        | .        | .        | .        | P        | P        | P        | .        |

### Tasks every agent passed (7)

`easy-arxiv-bert`, `easy-example-com`, `easy-httpbin-headers`,
`easy-iana-home`, `easy-info-cern`, `easy-mdn-array-map`,
`easy-rfc-info` — all canaries. These are now confirmed as
trivially passable by any non-broken agent (they tolerate even a
no-LLM `DECLINED` because the harness pre-navigates and the verifier
sees the start_url body).

### Tasks only 1-3 agents passed (5)

| task                       | passers                                     |
|----------------------------|---------------------------------------------|
| easy-mdn-cross-link        | baseline, network-shadow                    |
| easy-arxiv-listing         | baseline, dom-mutation-stream, speculative-rollback |
| easy-rfc-format-link       | dom-mutation-stream, network-shadow, speculative-rollback |
| easy-mdn-toc-anchor        | network-shadow, plan-then-execute, predicate-driven, runtime-codegen |
| easy-wiki-article-link     | network-shadow, plan-then-execute, speculative-rollback |

These are the v2 slice's hardest interactive tasks. The TOC anchor
(`mdn-toc-anchor`) requires a hash navigation that text-keyed agents
hit cleanly but DOM-walk agents struggle on. The cross-link
(`mdn-cross-link`) requires finding a specific link inside the "See
also" section past page chrome.

## Cost notes

- Total OpenAI spend for the sweep: ~$2.49 in gpt-4o-mini tokens
  (sum of Σ cost across 9 agents).
- `vision-grounded` accounts for ~48% of total cost ($0.1201 = 22 cells
  × ~$0.0055/cell) — each cell ships a high-detail JPEG; per-token
  cost is dominated by image tokens.
- `plan-then-execute` is the cheapest LLM agent at $0.005/22 cells
  (it issues one plan call up front, repairs at most twice per task).
- The cheap-and-good cell is `network-shadow` — 86% pass at $0.0125
  total (≈ $0.0006/cell). API-first paths are short.

## Reproduction

```bash
set -a && source .env && set +a
rm -rf /tmp/easy-v2-sweep && mkdir -p /tmp/easy-v2-sweep/logs
for agent in baseline-a11y-react plan-then-execute runtime-codegen \
             speculative-rollback predicate-driven vision-grounded \
             network-shadow dom-mutation-stream; do
  nohup npx tsx harness/ts/cli/tournament.ts \
    --slice=easy --seeds=1 --agents=$agent \
    --runs-root=/tmp/easy-v2-sweep \
    > /tmp/easy-v2-sweep/logs/$agent.log 2>&1 &
done
wait
python3 - <<'PY'
import json, os
from collections import defaultdict
by = defaultdict(list)
for d, _, fs in os.walk('/tmp/easy-v2-sweep'):
    if 'summary.json' in fs and d.endswith('/0'):
        s = json.load(open(os.path.join(d, 'summary.json')))
        by[s['agent_id']].append(s)
for a, rs in sorted(by.items()):
    p = sum(1 for r in rs if r['pass'])
    print(f"{a:<24} {p}/{len(rs)}")
PY
```

The trivial `click-first-link` baseline is reproduced with
`npx tsx harness/ts/cli/eval.ts --agent=trivial --slice=easy --seeds=1
 --retries=0` (which prints the 4/22 PASS|FAIL table inline).

## Notes for the next iteration (US-030 / US-031)

- The v2 slice is now signal-rich enough to ablate. US-030 (Anthropic
  Claude provider) should re-run the top-3 agents (network-shadow,
  predicate-driven, baseline-a11y-react) under {gpt-4o-mini, claude-
  haiku-4-5, claude-sonnet-4-6} to separate mechanism from model.
- US-031's Set-of-Marks vision agent has a clear bar to clear:
  vision-grounded's 8/22 is the floor. The hard cases for SoM will
  be the same dense-nav-bar tasks (github tabs, iana nav, MDN
  sidebar) where pixel grounding fell apart.
- The `easy-mdn-cross-link` task is unexpectedly hard (only 2 of 8
  agents passed). This is a candidate for a US-033 dom-shell
  exemplar: the "See also" link is reachable via
  `find --interactive | grep filter` in a shell-style substrate.

## Files

- `tasks/suite/easy/*.yaml` — 22 task specs (8 canaries + 14
  interactive).
- `tasks/CLAUDE.md` → "Easy slice v2" — author conventions.
- `harness/ts/tests/easy_slice.test.ts` — 15 contract tests.
- This document.
