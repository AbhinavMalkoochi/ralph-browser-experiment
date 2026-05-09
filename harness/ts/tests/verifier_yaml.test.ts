// Minimal YAML loader (harness/ts/verifier/yaml.ts) — exercises every feature
// the task spec format actually uses. Anything not covered here is unsupported
// on purpose.

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseYaml, InvalidYamlError } from "../verifier/yaml.js";

test("parseYaml: scalar mapping", () => {
  const v = parseYaml(`a: 1\nb: hello\nc: true\nd: null`);
  assert.deepEqual(v, { a: 1, b: "hello", c: true, d: null });
});

test("parseYaml: nested mapping", () => {
  const v = parseYaml(`outer:\n  inner: 42\n  deep:\n    a: x\n`);
  assert.deepEqual(v, { outer: { inner: 42, deep: { a: "x" } } });
});

test("parseYaml: block list", () => {
  const v = parseYaml(`tags:\n  - shadow_dom\n  - hard\n  - judge_required\n`);
  assert.deepEqual(v, { tags: ["shadow_dom", "hard", "judge_required"] });
});

test("parseYaml: inline flow list", () => {
  const v = parseYaml(`tags: [a, b, c]\nnums: [1, 2, 3]\n`);
  assert.deepEqual(v, { tags: ["a", "b", "c"], nums: [1, 2, 3] });
});

test("parseYaml: quoted strings preserve special chars", () => {
  const v = parseYaml(`a: "hello: world"\nb: 'with: colon'\nc: "tab\\there"\n`);
  assert.deepEqual(v, { a: "hello: world", b: "with: colon", c: "tab\there" });
});

test("parseYaml: comment handling", () => {
  const v = parseYaml(`# top-level comment\na: 1 # trailing\nb: "hash # inside string"\n`);
  assert.deepEqual(v, { a: 1, b: "hash # inside string" });
});

test("parseYaml: block scalar | preserves newlines", () => {
  const v = parseYaml(`expression: |\n  line one\n  line two\n`);
  assert.deepEqual(v, { expression: "line one\nline two\n" });
});

test("parseYaml: block scalar |- strips trailing newline", () => {
  const v = parseYaml(`expression: |-\n  one\n  two\n`);
  assert.deepEqual(v, { expression: "one\ntwo" });
});

test("parseYaml: block scalar > folds newlines into spaces", () => {
  const v = parseYaml(`folded: >\n  one\n  two\n  three\n`);
  // folded = "one two three\n"
  assert.deepEqual(v, { folded: "one two three\n" });
});

test("parseYaml: tabs in indent rejected", () => {
  assert.throws(
    () => parseYaml("a:\n\tinner: 1\n"),
    InvalidYamlError,
  );
});

test("parseYaml: rejects inline mapping in list element", () => {
  assert.throws(
    () => parseYaml(`items:\n  - a: 1\n`),
    InvalidYamlError,
  );
});

test("parseYaml: realistic task spec", () => {
  const yaml = `id: shadow-form
goal: |
  Submit the form values "alice" and "secret".
start_url: http://localhost:8123/shadow
difficulty: hard
tags:
  - shadow_dom
  - form
verifier:
  kind: js
  expression: |
    fetch('/__test/last').then(r => r.json()).then(j => j.user === 'alice')
`;
  const v = parseYaml(yaml) as Record<string, unknown>;
  assert.equal(v.id, "shadow-form");
  assert.equal(v.start_url, "http://localhost:8123/shadow");
  assert.equal(v.difficulty, "hard");
  assert.deepEqual(v.tags, ["shadow_dom", "form"]);
  assert.match(String(v.goal), /Submit the form/);
  const verifier = v.verifier as Record<string, string>;
  assert.equal(verifier.kind, "js");
  assert.match(verifier.expression as string, /fetch/);
});
