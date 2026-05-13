# General Browser Agent Tournament Leaderboard

_Generated 2026-05-13T01:00:30.907Z from `runs/leaderboard.json` (189 cells across 11 agents)._

> Run `make report` to regenerate. Source data: `runs/leaderboard.json` and `runs/<agent>/<task>/<seed>/summary.json`.

## Slice: `easy`

| rank | agent | pass | success | mean steps | mean cost | p50 ms | p95 ms | recovery | decline |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | [dom-mutation-stream](../agents/dom-mutation-stream/README.md) | 9/9 | 100.0% | 3.6 | $0.0009 | 1991 | 14145 | 0 | 2 |
| 2 | [speculative-rollback](../agents/speculative-rollback/README.md) | 9/9 | 100.0% | 7.7 | $0.0026 | 29593 | 35683 | 0 | 4 |
| 3 | [baseline-a11y-react](../agents/baseline-a11y-react/README.md) | 8/9 | 88.9% | 1.0 | $0.0000 | 15 | 113 | 0 | 9 |
| 4 | [plan-then-execute](../agents/plan-then-execute/README.md) | 8/9 | 88.9% | 4.1 | $0.0002 | 1016 | 2458 | 0 | 2 |
| 5 | [meta-mixture](../agents/meta-mixture/README.md) | 8/9 | 88.9% | 3.6 | $0.0008 | 1889 | 6021 | 0 | 1 |
| 6 | [network-shadow](../agents/network-shadow/README.md) | 8/9 | 88.9% | 3.6 | $0.0008 | 1889 | 6021 | 0 | 1 |
| 7 | [runtime-codegen](../agents/runtime-codegen/README.md) | 8/9 | 88.9% | 4.2 | $0.0011 | 1521 | 10585 | 0 | 2 |
| 8 | [vision-grounded](../agents/vision-grounded/README.md) | 8/9 | 88.9% | 2.0 | $0.0045 | 1570 | 20104 | 0 | 0 |
| 9 | [predicate-driven](../agents/predicate-driven/README.md) | 7/9 | 77.8% | 5.0 | $0.0008 | 1229 | 12104 | 0 | 3 |

## Slice: `hard`

| rank | agent | pass | success | mean steps | mean cost | p50 ms | p95 ms | recovery | decline |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | [runtime-codegen](../agents/runtime-codegen/README.md) | 5/10 | 50.0% | 9.2 | $0.0028 | 23175 | 55264 | 0 | 7 |
| 2 | [meta-mixture](../agents/meta-mixture/README.md) | 4/10 | 40.0% | 8.4 | $0.0017 | 11015 | 55264 | 0 | 7 |
| 3 | [network-shadow](../agents/network-shadow/README.md) | 3/10 | 30.0% | 8.1 | $0.0013 | 10301 | 15187 | 0 | 8 |
| 4 | [codegen-predicate](../agents/codegen-predicate/README.md) | 2/9 | 22.2% | 10.6 | $0.0029 | 14817 | 81717 | 0 | 7 |
| 5 | [plan-then-execute](../agents/plan-then-execute/README.md) | 2/10 | 20.0% | 8.6 | $0.0004 | 5837 | 13775 | 0 | 7 |
| 6 | [predicate-driven](../agents/predicate-driven/README.md) | 2/10 | 20.0% | 11.0 | $0.0014 | 10827 | 12286 | 0 | 10 |
| 7 | [dom-mutation-stream](../agents/dom-mutation-stream/README.md) | 2/10 | 20.0% | 9.5 | $0.0014 | 14529 | 46732 | 0 | 9 |
| 8 | [speculative-rollback](../agents/speculative-rollback/README.md) | 1/10 | 10.0% | 11.8 | $0.0031 | 28739 | 32985 | 0 | 10 |
| 9 | [click-first-link](../agents/click-first-link/README.md) | 0/19 | 0.0% | 1.0 | $0.0000 | 16 | 47 | 0 | 13 |
| 10 | [vision-grounded](../agents/vision-grounded/README.md) | 0/10 | 0.0% | 10.0 | $0.0228 | 46105 | 47565 | 0 | 10 |

## Overall ranking

_Combines every cell across all slices. Use the per-slice tables above for slice-specific judgment._

| rank | agent | pass | success | mean steps | mean cost | p50 ms | p95 ms | recovery | decline |
|---:|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | [baseline-a11y-react](../agents/baseline-a11y-react/README.md) | 8/9 | 88.9% | 1.0 | $0.0000 | 15 | 113 | 0 | 9 |
| 2 | [runtime-codegen](../agents/runtime-codegen/README.md) | 13/19 | 68.4% | 6.8 | $0.0020 | 9351 | 44337 | 0 | 9 |
| 3 | [meta-mixture](../agents/meta-mixture/README.md) | 12/19 | 63.2% | 6.1 | $0.0012 | 3439 | 44337 | 0 | 8 |
| 4 | [network-shadow](../agents/network-shadow/README.md) | 11/19 | 57.9% | 5.9 | $0.0010 | 2770 | 14613 | 0 | 9 |
| 5 | [dom-mutation-stream](../agents/dom-mutation-stream/README.md) | 11/19 | 57.9% | 6.7 | $0.0011 | 6302 | 45820 | 0 | 11 |
| 6 | [plan-then-execute](../agents/plan-then-execute/README.md) | 10/19 | 52.6% | 6.5 | $0.0003 | 4474 | 13425 | 0 | 9 |
| 7 | [speculative-rollback](../agents/speculative-rollback/README.md) | 10/19 | 52.6% | 9.8 | $0.0028 | 29187 | 35492 | 0 | 14 |
| 8 | [predicate-driven](../agents/predicate-driven/README.md) | 9/19 | 47.4% | 8.2 | $0.0011 | 10256 | 12347 | 0 | 13 |
| 9 | [vision-grounded](../agents/vision-grounded/README.md) | 8/19 | 42.1% | 6.2 | $0.0141 | 32715 | 47529 | 0 | 10 |
| 10 | [codegen-predicate](../agents/codegen-predicate/README.md) | 2/9 | 22.2% | 10.6 | $0.0029 | 14817 | 81717 | 0 | 7 |
| 11 | [click-first-link](../agents/click-first-link/README.md) | 0/19 | 0.0% | 1.0 | $0.0000 | 16 | 47 | 0 | 13 |

## Pareto front (success vs mean cost)

Each point is one agent's overall (success_pct, mean_cost_usd). An agent is on the Pareto front if no other agent matches its success at lower cost.

```text
success ^
100% |                                         
 89% | *                                       
 78% |                                         
 67% |    o  o                                 
 56% |  o +    o                               
 44% |    o                                   o
 33% |                                         
 22% |         o                               
 11% |                                         
  0% | o                                       
     +-----------------------------------------> mean_cost_usd
        $0.00                            $0.01
legend: * = pareto-optimal, o = dominated, + = overlap
```

**Pareto-optimal agents:**
- baseline-a11y-react — 88.9% success at $0.0000/cell (8/9 passed)

## Best trajectory per agent

| agent | task | seed | pass | score | cost | trajectory |
|---|---|---:|:---:|---:|---:|---|
| baseline-a11y-react | easy-example-com | 0 | ✓ | 1.00 | $0.0000 | [trajectory.jsonl.gz](../runs/baseline-a11y-react/easy-example-com/0/trajectory.jsonl.gz) |
| click-first-link | hard-app-excalidraw-rename-element | 0 | ✗ | 0.00 | $0.0000 | [trajectory.jsonl.gz](../runs/click-first-link/hard-app-excalidraw-rename-element/0/trajectory.jsonl.gz) |
| codegen-predicate | hard-late-hydration | 0 | ✓ | 1.00 | $0.0003 | [trajectory.jsonl.gz](../runs/codegen-predicate/hard-late-hydration/0/trajectory.jsonl.gz) |
| dom-mutation-stream | easy-example-com | 0 | ✓ | 1.00 | $0.0001 | [trajectory.jsonl.gz](../runs/dom-mutation-stream/easy-example-com/0/trajectory.jsonl.gz) |
| meta-mixture | easy-example-com | 0 | ✓ | 1.00 | $0.0002 | [trajectory.jsonl.gz](../runs/meta-mixture/easy-example-com/0/trajectory.jsonl.gz) |
| network-shadow | easy-example-com | 0 | ✓ | 1.00 | $0.0002 | [trajectory.jsonl.gz](../runs/network-shadow/easy-example-com/0/trajectory.jsonl.gz) |
| plan-then-execute | easy-httpbin-headers | 0 | ✓ | 1.00 | $0.0001 | [trajectory.jsonl.gz](../runs/plan-then-execute/easy-httpbin-headers/0/trajectory.jsonl.gz) |
| predicate-driven | easy-example-com | 0 | ✓ | 1.00 | $0.0001 | [trajectory.jsonl.gz](../runs/predicate-driven/easy-example-com/0/trajectory.jsonl.gz) |
| runtime-codegen | easy-example-com | 0 | ✓ | 1.00 | $0.0002 | [trajectory.jsonl.gz](../runs/runtime-codegen/easy-example-com/0/trajectory.jsonl.gz) |
| speculative-rollback | easy-example-com | 0 | ✓ | 1.00 | $0.0001 | [trajectory.jsonl.gz](../runs/speculative-rollback/easy-example-com/0/trajectory.jsonl.gz) |
| vision-grounded | easy-httpbin-headers | 0 | ✓ | 1.00 | $0.0022 | [trajectory.jsonl.gz](../runs/vision-grounded/easy-httpbin-headers/0/trajectory.jsonl.gz) |

## Failure clusters

_95 failed cells across the latest run. Failures are grouped by terminal_state (error class) and by task tag. A cell with N tags contributes once to each tag bucket._

### By error class

| terminal_state | failures |
|---|---:|
| `DECLINED` | 85 |
| `DONE` | 8 |
| `BUDGET_EXCEEDED` | 1 |
| `DONE_BY_PREDICATE` | 1 |

### By task tag

| tag | failures |
|---|---:|
| `fixtures` | 78 |
| `hard` | 78 |
| `server_receipt` | 39 |
| `drag_drop` | 20 |
| `form` | 16 |
| `irreversible` | 15 |
| `canvas` | 10 |
| `conditional` | 10 |
| `cross_frame` | 10 |
| `download` | 10 |
| `extraction` | 10 |
| `iframe` | 10 |
| `multi_tab` | 10 |
| `pdf` | 10 |
| `postmessage` | 10 |
| `spatial` | 10 |
| `easy` | 8 |
| `public` | 8 |
| `fill` | 7 |
| `hydration` | 7 |
| `interactive` | 7 |
| `long_list` | 7 |
| `pattern:httpbin_form_submit` | 7 |
| `scroll` | 7 |
| `spa` | 7 |
| `timing` | 7 |
| `virtualization` | 7 |
| `shadow_dom` | 6 |
| `modal` | 5 |
| `state_machine` | 5 |
| `error_handling` | 3 |
| `retry` | 3 |
| `canary` | 1 |
| `extract` | 1 |
| `pattern:wiki_article_extract` | 1 |

### Top failing tasks

| task | difficulty | failures | tags |
|---|---|---:|---|
| hard-canvas-drag | hard | 10 | `hard` `fixtures` `canvas` `drag_drop` `spatial` |
| hard-conditional-form | hard | 10 | `hard` `fixtures` `form` `conditional` `server_receipt` `irreversible` |
| hard-iframe-drag | hard | 10 | `hard` `fixtures` `iframe` `drag_drop` `cross_frame` |
| hard-multi-tab | hard | 10 | `hard` `fixtures` `multi_tab` `postmessage` `server_receipt` |
| hard-pdf-task | hard | 10 | `hard` `fixtures` `pdf` `download` `extraction` `server_receipt` |
| easy-httpbin-form | easy | 7 | `easy` `fill` `public` `interactive` `pattern:httpbin_form_submit` |
| hard-late-hydration | hard | 7 | `hard` `fixtures` `hydration` `timing` `spa` |
| hard-virtual-scroll | hard | 7 | `hard` `fixtures` `virtualization` `scroll` `long_list` |
| hard-shadow-form | hard | 6 | `hard` `fixtures` `shadow_dom` `form` `server_receipt` |
| hard-modal-stack | hard | 5 | `hard` `fixtures` `modal` `state_machine` `irreversible` |
| hard-recoverable | hard | 3 | `hard` `fixtures` `retry` `error_handling` `server_receipt` |
| easy-wiki-linux | easy | 1 | `easy` `extract` `public` `canary` `pattern:wiki_article_extract` |
| hard-app-bookstack-create-page | hard | 1 | _(unknown)_ |
| hard-app-bookstack-find-page | hard | 1 | _(unknown)_ |
| hard-app-excalidraw-rename-element | hard | 1 | _(unknown)_ |
| hard-app-excalidraw-three-shapes | hard | 1 | _(unknown)_ |
| hard-app-gitea-comment-issue | hard | 1 | _(unknown)_ |
| hard-app-gitea-new-issue | hard | 1 | _(unknown)_ |
| hard-app-gitea-pr-comment | hard | 1 | _(unknown)_ |
| hard-app-vikunja-add-task | hard | 1 | _(unknown)_ |

### Recent failure trajectories

- codegen-predicate / hard-recoverable / seed=0 — `DONE_BY_PREDICATE`: js: false ([trajectory](../runs/codegen-predicate/hard-recoverable/0/trajectory.jsonl.gz))
- codegen-predicate / hard-pdf-task / seed=0 — `DECLINED`: max steps (12) exhausted with predicate still false ([trajectory](../runs/codegen-predicate/hard-pdf-task/0/trajectory.jsonl.gz))
- codegen-predicate / hard-multi-tab / seed=0 — `DECLINED`: max steps (12) exhausted with predicate still false ([trajectory](../runs/codegen-predicate/hard-multi-tab/0/trajectory.jsonl.gz))
- codegen-predicate / hard-modal-stack / seed=0 — `DECLINED`: max steps (12) exhausted with predicate still false ([trajectory](../runs/codegen-predicate/hard-modal-stack/0/trajectory.jsonl.gz))
- codegen-predicate / hard-iframe-drag / seed=0 — `DECLINED`: max steps (12) exhausted with predicate still false ([trajectory](../runs/codegen-predicate/hard-iframe-drag/0/trajectory.jsonl.gz))
- codegen-predicate / hard-conditional-form / seed=0 — `DECLINED`: max steps (12) exhausted with predicate still false ([trajectory](../runs/codegen-predicate/hard-conditional-form/0/trajectory.jsonl.gz))
- codegen-predicate / hard-canvas-drag / seed=0 — `DECLINED`: max steps (12) exhausted with predicate still false ([trajectory](../runs/codegen-predicate/hard-canvas-drag/0/trajectory.jsonl.gz))
- click-first-link / hard-app-vikunja-mark-done / seed=0 — `DECLINED`: no links on page ([trajectory](../runs/click-first-link/hard-app-vikunja-mark-done/0/trajectory.jsonl.gz))
- click-first-link / hard-app-vikunja-add-task / seed=0 — `DECLINED`: no links on page ([trajectory](../runs/click-first-link/hard-app-vikunja-add-task/0/trajectory.jsonl.gz))
- click-first-link / hard-app-gitea-pr-comment / seed=0 — `DONE`: no review comment with the required phrase ([trajectory](../runs/click-first-link/hard-app-gitea-pr-comment/0/trajectory.jsonl.gz))
