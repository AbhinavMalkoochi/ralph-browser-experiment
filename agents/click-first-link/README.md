# click-first-link (TS reference agent)

A two-step trivial agent that exists solely to demonstrate the
`Agent` / `BrowserSession` / `Trajectory` contract end-to-end. **Not a
tournament participant.**

## Behaviour

1. Evaluate `document.querySelectorAll('a')` and collect every `href`.
2. If there are zero links, write a `noop` step and finish with
   `terminal_state=DECLINED, decline_reason="no links on page"`.
3. Otherwise write a `click_link` step pointing at `links[0]`, set
   `window.location.href`, and finish with `terminal_state=DONE`.

The agent does not call any LLM, never recovers from errors, and ignores the
`goal` string except for echoing it into `observation_summary`.

## Why it is useful

- Smallest possible Agent that exercises every required code path: trajectory
  open, step append, gzip-on-finish, budget step accounting, BrowserSession
  evaluate.
- Used by `harness/ts/tests/agent.test.ts` to assert the contract on real
  Chrome.
- Reference for the Python sibling at `agents/click-first-link-py/`.
