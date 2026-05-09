// Stub. Full tournament runner lands with US-010.
export {};

interface Args {
  slice?: string;
  seeds?: string;
  bracket?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === undefined || value === undefined) continue;
    if (key === "slice") out.slice = value;
    else if (key === "seeds") out.seeds = value;
    else if (key === "bracket") out.bracket = value;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
console.log(
  `[tournament] STUB: slice=${args.slice ?? "easy"} seeds=${args.seeds ?? "1"} bracket=${args.bracket ?? "off"}`,
);
console.log("[tournament] tournament runner lands in US-010.");
