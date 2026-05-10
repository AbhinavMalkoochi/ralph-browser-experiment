// Boot the fixtures server in the foreground.
//
// Usage:
//   npx tsx tasks/fixtures/serve.ts [--port=PORT]
//
// Prints the bound origin on the first line of stdout so wrappers can capture
// it, then waits for SIGINT/SIGTERM to shut down cleanly.

import { startFixturesServer } from "./server.js";

interface Args {
  port?: number;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (const arg of argv) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (key === "port" && value !== undefined) {
      const n = Number.parseInt(value, 10);
      if (Number.isFinite(n)) out.port = n;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const server = await startFixturesServer({ port: args.port });
  process.stdout.write(`fixtures origin: ${server.origin}\n`);
  process.stdout.write(`pages: /shadow-form /canvas-drag /virtual-scroll\n`);
  const shutdown = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

void main();
