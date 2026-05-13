// Filesystem-as-working-memory: a per-task scratch directory that is the
// agent's *only* persistent observation memory between turns.
//
// The agent does NOT accumulate observations in the prompt (HISTORY_LIMIT=1
// in agent.ts). Anything it wants to remember between steps must be written
// to the scratch dir via fs.write/fs.append and re-read via fs.read. This
// inverts the universal "history goes in the prompt" convention: prompts
// stay compact and constant-shape; working memory lives on disk and is
// curated by the LLM itself.
//
// Path safety: all paths are interpreted relative to the scratch root. Any
// attempt to escape the root (absolute paths, "..", trailing nulls) is
// rejected by sanitise().

import { mkdir, readdir, readFile, rm, stat, writeFile, appendFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";

const MAX_PATH = 200;
const MAX_FILE_BYTES = 32_768; // 32KB hard cap per file — pressure the agent to summarise
const MAX_READ_BYTES = 4_000; // window surfaced to the LLM

export class ScratchPathError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
    this.name = "ScratchPathError";
  }
}

export class ScratchFs {
  private readonly root: string;
  private created = false;

  constructor(root: string) {
    this.root = root;
  }

  /**
   * Reject paths that would escape the scratch root, contain null bytes,
   * or are absolute / windows-drive-prefixed. Returns the safe absolute
   * path inside the root.
   */
  resolve(raw: string): string {
    if (typeof raw !== "string") {
      throw new ScratchPathError("path must be a string", String(raw));
    }
    const trimmed = raw.trim().replace(/^\.\//, "");
    if (trimmed.length === 0) throw new ScratchPathError("path is empty", raw);
    if (trimmed.length > MAX_PATH)
      throw new ScratchPathError(`path longer than ${MAX_PATH} chars`, raw);
    if (trimmed.includes("\0")) throw new ScratchPathError("null byte in path", raw);
    if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed))
      throw new ScratchPathError("absolute paths are not allowed", raw);
    const norm = normalize(trimmed);
    if (norm === "." || norm === "..") throw new ScratchPathError("path resolves to root", raw);
    if (norm.startsWith("..") || norm.split(sep).includes(".."))
      throw new ScratchPathError("path escapes scratch root", raw);
    return join(this.root, norm);
  }

  /** Display path relative to root (forward-slashed for readability). */
  display(abs: string): string {
    const rel = abs.startsWith(this.root) ? abs.slice(this.root.length) : abs;
    return rel.replace(/^[\\/]/, "").split(sep).join("/");
  }

  private async ensureRoot(): Promise<void> {
    if (this.created) return;
    await mkdir(this.root, { recursive: true });
    this.created = true;
  }

  async write(path: string, content: string): Promise<{ bytes: number; path: string }> {
    const abs = this.resolve(path);
    await this.ensureRoot();
    await mkdir(dirname(abs), { recursive: true });
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILE_BYTES)
      throw new ScratchPathError(`file would exceed ${MAX_FILE_BYTES} bytes`, path);
    await writeFile(abs, content, "utf8");
    return { bytes, path: this.display(abs) };
  }

  async append(path: string, content: string): Promise<{ bytes: number; path: string }> {
    const abs = this.resolve(path);
    await this.ensureRoot();
    await mkdir(dirname(abs), { recursive: true });
    let existing = 0;
    try {
      const s = await stat(abs);
      existing = s.size;
    } catch {
      // first append == create
    }
    const adding = Buffer.byteLength(content, "utf8");
    if (existing + adding > MAX_FILE_BYTES)
      throw new ScratchPathError(`file would exceed ${MAX_FILE_BYTES} bytes`, path);
    await appendFile(abs, content, "utf8");
    return { bytes: existing + adding, path: this.display(abs) };
  }

  async read(path: string): Promise<{ content: string; truncated: boolean; bytes: number }> {
    const abs = this.resolve(path);
    const buf = await readFile(abs);
    const truncated = buf.length > MAX_READ_BYTES;
    const slice = truncated ? buf.subarray(0, MAX_READ_BYTES) : buf;
    return { content: slice.toString("utf8"), truncated, bytes: buf.length };
  }

  async remove(path: string): Promise<void> {
    const abs = this.resolve(path);
    await rm(abs, { recursive: true, force: true });
  }

  /**
   * List the entire scratch tree (depth-first). Returned entries are
   * display-form paths (no leading slash, forward slashes only) with a
   * trailing `/` on directories.
   */
  async tree(): Promise<string[]> {
    await this.ensureRoot();
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          out.push(this.display(full) + "/");
          await walk(full);
        } else if (e.isFile()) {
          try {
            const s = await stat(full);
            out.push(`${this.display(full)} (${s.size}B)`);
          } catch {
            out.push(this.display(full));
          }
        }
      }
    };
    await walk(this.root);
    return out;
  }

  static readonly MAX_FILE_BYTES = MAX_FILE_BYTES;
  static readonly MAX_READ_BYTES = MAX_READ_BYTES;
}
