// Minimal YAML loader.
//
// Supports the subset that task specs need:
//   - top-level mapping (key: value)
//   - nested mappings (indent-based, 2-space recommended but any consistent
//     indent works because we track per-level indents on a stack)
//   - block lists ("- item" lines)
//   - inline flow lists ("[a, b, c]")
//   - quoted strings (single and double)
//   - numbers, booleans (true/false/yes/no), null/~
//   - block scalars ("|" preserves newlines, "|-" strips trailing newline,
//     ">" folds newlines into spaces, ">-" same with trailing strip)
//   - "#" comments to end-of-line (outside of quoted strings)
//
// NOT supported (intentional, raise InvalidYamlError if encountered):
//   - anchors / aliases (& *)
//   - tags (!!str etc.)
//   - flow mappings ({a: 1, b: 2})
//   - inline mapping in a list element ("- a: 1")  (wrap in nested form)
//   - tabs as indent (YAML disallows them too)
//
// This is enough for the task spec format used by the harness; richer YAML
// features can be added later if a real need arises.

export class InvalidYamlError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`yaml line ${line}: ${message}`);
    this.name = "InvalidYamlError";
    this.line = line;
  }
}

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [k: string]: YamlValue };

interface RawLine {
  indent: number;
  content: string;
  raw: string;
  lineNo: number;
}

export function parseYaml(source: string): YamlValue {
  const lines = preprocess(source);
  const [value, end] = parseNode(lines, 0, -1);
  if (end < lines.length) {
    throw new InvalidYamlError(`unexpected trailing content`, lines[end]?.lineNo ?? 0);
  }
  return value;
}

function preprocess(source: string): RawLine[] {
  const out: RawLine[] = [];
  const split = source.split(/\r?\n/);
  for (let i = 0; i < split.length; i++) {
    const raw = split[i] ?? "";
    if (raw.includes("\t")) {
      // Tabs are not allowed for indentation; reject early.
      // Allow tabs ONLY inside quoted scalars: scan past leading whitespace.
      const leading = raw.match(/^[\s]*/)?.[0] ?? "";
      if (leading.includes("\t")) {
        throw new InvalidYamlError("tabs are not allowed in indentation", i + 1);
      }
    }
    const stripped = stripComment(raw);
    if (stripped.trim().length === 0) continue;
    const indent = stripped.match(/^ */)?.[0].length ?? 0;
    out.push({ indent, content: stripped.slice(indent), raw, lineNo: i + 1 });
  }
  return out;
}

function stripComment(line: string): string {
  // Strip everything from a `#` that is OUTSIDE of quoted strings to the end.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === "#" && !inSingle && !inDouble) {
      const prev = i > 0 ? line[i - 1] : " ";
      if (prev === " " || prev === "\t" || i === 0) return line.slice(0, i).trimEnd();
    }
  }
  return line;
}

/**
 * Parse a node starting at `lines[i]`. The node belongs to the parent context
 * if its indent is `> parentIndent`. Returns the parsed value and the index of
 * the first line NOT consumed.
 */
function parseNode(lines: RawLine[], i: number, parentIndent: number): [YamlValue, number] {
  if (i >= lines.length) return [null, i];
  const first = lines[i];
  if (!first || first.indent <= parentIndent) return [null, i];

  const indent = first.indent;
  if (first.content.startsWith("- ") || first.content === "-") {
    return parseList(lines, i, indent);
  }
  return parseMapping(lines, i, indent);
}

function parseList(lines: RawLine[], i: number, indent: number): [YamlValue[], number] {
  const out: YamlValue[] = [];
  while (i < lines.length) {
    const ln = lines[i];
    if (!ln || ln.indent < indent) break;
    if (ln.indent > indent) {
      throw new InvalidYamlError("over-indented list item", ln.lineNo);
    }
    if (!ln.content.startsWith("-")) break;
    const after = ln.content === "-" ? "" : ln.content.slice(2);
    if (after.length === 0) {
      // The list item's value is the nested block.
      const [val, next] = parseNode(lines, i + 1, indent);
      out.push(val);
      i = next;
      continue;
    }
    if (after.includes(": ") || after.endsWith(":")) {
      throw new InvalidYamlError(
        "inline mapping in list item is not supported; nest the mapping on the next line",
        ln.lineNo,
      );
    }
    out.push(parseScalar(after, ln.lineNo));
    i++;
  }
  return [out, i];
}

function parseMapping(lines: RawLine[], i: number, indent: number): [Record<string, YamlValue>, number] {
  const out: Record<string, YamlValue> = {};
  while (i < lines.length) {
    const ln = lines[i];
    if (!ln || ln.indent < indent) break;
    if (ln.indent > indent) {
      throw new InvalidYamlError("over-indented key", ln.lineNo);
    }
    if (ln.content.startsWith("- ") || ln.content === "-") break;
    const colon = findKeyColon(ln.content);
    if (colon < 0) {
      throw new InvalidYamlError(`expected "key: value", got ${JSON.stringify(ln.content)}`, ln.lineNo);
    }
    const key = unquote(ln.content.slice(0, colon).trimEnd(), ln.lineNo);
    const rest = ln.content.slice(colon + 1).trimStart();
    if (rest.length === 0) {
      // Either a nested mapping/list block, or null.
      const [val, next] = parseNode(lines, i + 1, indent);
      out[key] = val;
      i = next;
    } else if (rest.startsWith("|") || rest.startsWith(">")) {
      const [val, next] = parseBlockScalar(lines, i, indent, rest);
      out[key] = val;
      i = next;
    } else if (rest.startsWith("[")) {
      out[key] = parseFlowList(rest, ln.lineNo);
      i++;
    } else {
      out[key] = parseScalar(rest, ln.lineNo);
      i++;
    }
  }
  return [out, i];
}

/** Find the index of the `:` that separates a key from its value, ignoring quoted regions. */
function findKeyColon(s: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === ":" && !inSingle && !inDouble) {
      const next = s[i + 1];
      if (next === undefined || next === " " || next === "\t" || i === s.length - 1) {
        return i;
      }
    }
  }
  return -1;
}

function unquote(s: string, lineNo: number): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return JSON.parse(s) as string;
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.length === 0) {
    throw new InvalidYamlError("empty key", lineNo);
  }
  return s;
}

function parseScalar(raw: string, lineNo: number): YamlValue {
  const t = raw.trim();
  if (t.length === 0) return null;
  if (t === "null" || t === "~") return null;
  if (t === "true" || t === "True" || t === "TRUE" || t === "yes" || t === "Yes") return true;
  if (t === "false" || t === "False" || t === "FALSE" || t === "no" || t === "No") return false;
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return JSON.parse(t) as string;
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (t.startsWith("[")) return parseFlowList(t, lineNo);
  if (/^-?\d+$/.test(t)) return Number.parseInt(t, 10);
  if (/^-?\d*\.\d+(?:[eE][-+]?\d+)?$/.test(t)) return Number.parseFloat(t);
  if (/^-?\d+[eE][-+]?\d+$/.test(t)) return Number.parseFloat(t);
  return t;
}

function parseFlowList(raw: string, lineNo: number): YamlValue[] {
  const t = raw.trim();
  if (!t.startsWith("[") || !t.endsWith("]")) {
    throw new InvalidYamlError("malformed flow list", lineNo);
  }
  const inner = t.slice(1, -1).trim();
  if (inner.length === 0) return [];
  const items: string[] = [];
  let buf = "";
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (!inSingle && !inDouble) {
      if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") depth--;
      else if (c === "," && depth === 0) {
        items.push(buf.trim());
        buf = "";
        continue;
      }
    }
    buf += c;
  }
  if (buf.trim().length > 0) items.push(buf.trim());
  return items.map((item) => parseScalar(item, lineNo));
}

function parseBlockScalar(
  lines: RawLine[],
  i: number,
  parentIndent: number,
  header: string,
): [string, number] {
  // Header is one of: "|", "|-", "|+", ">", ">-", ">+"
  const m = header.match(/^([|>])([+-]?)\s*$/);
  if (!m) {
    throw new InvalidYamlError(`unsupported block scalar header ${JSON.stringify(header)}`, lines[i]?.lineNo ?? 0);
  }
  const style = m[1] as "|" | ">";
  const chomp = (m[2] ?? "") as "" | "-" | "+";
  const collected: { indent: number; raw: string; lineNo: number }[] = [];
  let j = i + 1;
  let blockIndent: number | null = null;
  while (j < lines.length) {
    const ln = lines[j];
    if (!ln) break;
    if (ln.indent <= parentIndent) break;
    if (blockIndent === null) blockIndent = ln.indent;
    if (ln.indent < blockIndent) break;
    collected.push({ indent: ln.indent, raw: ln.raw, lineNo: ln.lineNo });
    j++;
  }
  if (collected.length === 0) return ["", j];
  const indent = blockIndent ?? collected[0]?.indent ?? 0;
  const stripped = collected.map((c) => c.raw.slice(indent));
  let body: string;
  if (style === "|") {
    body = stripped.join("\n");
  } else {
    body = stripped.join(" ");
  }
  if (chomp === "-") {
    body = body.replace(/\s+$/, "");
  } else if (chomp === "") {
    body = body.replace(/\s+$/, "") + "\n";
  } else {
    if (!body.endsWith("\n")) body += "\n";
  }
  return [body, j];
}
