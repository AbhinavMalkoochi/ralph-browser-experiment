// Stub. Full eval pipeline lands with US-009 (easy slice loader) and the
// tournament runner (US-010). Exits 0 with a clear note so make targets work.
export {};

interface Args {
  agent?: string;
  slice?: string;
  seeds?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === undefined || value === undefined) continue;
    if (key === "agent") out.agent = value;
    else if (key === "slice") out.slice = value;
    else if (key === "seeds") out.seeds = value;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
console.log(
  `[eval] STUB: agent=${args.agent ?? "trivial"} slice=${args.slice ?? "easy"} seeds=${args.seeds ?? "1"}`,
);
console.log("[eval] eval pipeline lands in US-009/US-010.");
