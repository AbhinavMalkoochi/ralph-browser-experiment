# dom-shell — DOM-as-filesystem agent (US-033)

The DOM tree IS the filesystem. The LLM is a shell user. Each turn the LLM
emits ONE shell-style command line. The harness tokenises it, compiles it to
a small in-page handler dispatch via CDP `Runtime.evaluate`, and persists the
result. The CWD — a CSS-selector chain — PERSISTS across turns.

## Why this mechanism

Prior agents treat each turn as a fresh round-trip against the whole page:

- **baseline-a11y-react** stamps every interactive element with a `data-gba-aid`
  and asks the LLM to pick an integer from a flat list.
- **plan-then-execute** asks the LLM to commit to a full plan up-front, then
  executes it.
- **runtime-codegen** lets the LLM author arbitrary JS bodies — maximum
  power, maximum surface area.
- **predicate-driven / speculative-rollback / codegen-predicate** vary the
  termination / commit semantics but keep a stateless per-step view.

`dom-shell` is the opposite bet: the LLM gets a TINY vocabulary (11 commands,
all compiled by the harness) but is rewarded for **navigating** the DOM tree
with persistent state. `cd form#login` once, and the next ten commands
operate inside that form with terse local-relative selectors.

The bet:

1. A tiny vocabulary is easier for small models (gpt-4o-mini) to learn than
   open-ended JS, and removes the entire class of JS syntax / contract bugs
   that runtime-codegen has to self-correct.
2. A persistent cwd is structurally suited to **subtree-shaped affordances**
   — shadow hosts, deeply-nested forms, table cells, scoped widgets. The LLM
   sets the scope once and amortises selector terseness over many turns.
3. The shell metaphor leans on capabilities every LLM already has from
   training data (`ls`, `cd`, `cat`, `grep`, `find`).

## Vocabulary

```
ls [selector]                   list children of cwd (or cwd>selector)
cd <selector|..|/>              push / pop / reset cwd
cat [selector]                  read innerText (capped 4000 chars)
grep <regex> [selector]         filter cat output by regex
find <selector> [--interactive] querySelectorAll under cwd, visible only
attr <name> [selector]          read one attribute
click <selector>                click an element (cwd-relative)
type <selector> "<text>" [--submit]   fill input; --submit presses Enter
scroll [up|down] [pixels]       scroll the viewport (default: down 400)
wait [ms]                       sleep (default 400, cap 5000)
done <reason>                   goal met
decline <reason>                cannot proceed
```

**Quoting**: double or single quotes around args with spaces. Backslash
escapes the next character inside a quoted string. `#` is NOT a comment
character — it is a CSS id selector character (`form#login`).

**Parser tolerance**: a fenced block (`\`\`\` ... \`\`\``) is unwrapped; if
the LLM emits prose followed by the command on a new line, the LAST
non-empty non-comment line is taken as the command. This costs nothing and
saves a parse-error round-trip on chatty turns.

## CWD algebra

- `cd /` → reset to root (empty stack).
- `cd ..` → pop one segment. Pop on an empty stack is a no-op.
- `cd <selector>` → push the segment onto the stack. The full cwd selector
  is the segments joined with the descendant combinator (space).
- `cd /<selector>` → absolute reset followed by push.
- Before any `cd` is committed, the harness probes the new cwd selector
  in-page. If it does not resolve, **cwd is unchanged** and the failure is
  surfaced as the step result.
- Between steps, the harness probes the current cwd selector; if a
  navigation invalidated it, cwd is silently reset to root before the next
  prompt. (AC: "cwd survives navigations only if the selector still
  resolves.")

## Compile-to-evaluate

Every command except `wait`, `done`, `decline`, `cd` compiles to a single
`Runtime.evaluate` of the form

```
(() => { /* in-page handler */; return __gba_dom_shell({cwd, cmd, args}); })()
```

The in-page handler is defined inline so we never depend on prior page
state. The return value is a JSON-serialisable
`{ok, output, error?, extras?}` object the agent loop consumes and the
trajectory persists.

`cd` is pure agent-side state, but the harness still issues a `probe-cwd`
evaluate so a "selector unresolved" error surfaces immediately rather than
on the next action.

## Trajectory

Every step records:

```json
{
  "type": "shell",
  "cmd": "click",
  "label": "click \"Continue\"",
  "cwd": "/form#login",
  "ok": true,
  "output": "clicked <button> \"Continue\"",
  "error": null,
  "extras": {}
}
```

`cwd` is captured on every step so post-hoc analysis can replay the LLM's
navigation through the DOM — which subtrees it explored, where it got
stuck, where it found the affordance.

## Distinctness

- vs **runtime-codegen**: same evaluate substrate, but the LLM does NOT
  write JS. The vocabulary is fixed (11 commands), the compile path is
  owned by the harness, and the cwd is the LLM's state-of-the-world.
- vs **baseline-a11y-react** / **plan-then-execute**: action set is shell
  commands, not aids or text. Selectors are CSS. Persistent cwd is novel.
- vs **predicate-driven** / **speculative-rollback** / **codegen-predicate**:
  those vary the TERMINATION/commit layer; we vary the ACTION substrate
  itself.
- approach_keywords have Jaccard=0 against every prior agent.

## Tunables

`DomShellAgent({ model, maxSteps, llmFactory })`:

- `model` — default `gpt-4o-mini` (or `GBA_MODEL`).
- `maxSteps` — default 16. Higher than most because the cwd workflow
  expects a `cd` + several local commands per affordance.
- `llmFactory` — DI hook for tests.
