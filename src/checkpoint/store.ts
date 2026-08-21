/**
 * Checkpoint store (spec §25, §28): session-local, git-ignored.
 *
 *   ~/.pi/context-engine/sessions/<session-id>/
 *   ├── state.json
 *   ├── pins.json
 *   ├── metrics.jsonl
 *   ├── prune-log.jsonl
 *   └── checkpoints/
 *       ├── cp-0001.json
 *       ├── cp-0002.json
 *       └── latest.json
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Checkpoint } from "../types.ts";

export class SessionStore {
  readonly root: string;
  readonly sessionDir: string;
  readonly checkpointDir: string;
  readonly stateFile: string;
  readonly pinsFile: string;
  readonly metricsFile: string;
  readonly pruneLogFile: string;

  private buffer: Array<{ file: "metrics" | "prune-log"; line: string }> = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(stateDir: string, sessionId: string) {
    this.root = stateDir;
    this.sessionDir = join(stateDir, "sessions", sessionId);
    this.checkpointDir = join(this.sessionDir, "checkpoints");
    this.stateFile = join(this.sessionDir, "state.json");
    this.pinsFile = join(this.sessionDir, "pins.json");
    this.metricsFile = join(this.sessionDir, "metrics.jsonl");
    this.pruneLogFile = join(this.sessionDir, "prune-log.jsonl");
  }

  ensure(): void {
    mkdirSync(this.checkpointDir, { recursive: true });
  }

  // ---- state.json ---------------------------------------------------------

  loadState<T>(): T | undefined {
    try {
      return JSON.parse(readFileSync(this.stateFile, "utf8")) as T;
    } catch {
      return undefined;
    }
  }

  saveState(state: unknown): void {
    this.ensure();
    writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
  }

  // ---- pins.json ----------------------------------------------------------

  loadPins(): unknown {
    try {
      return JSON.parse(readFileSync(this.pinsFile, "utf8")) as unknown;
    } catch {
      return undefined;
    }
  }

  savePins(pins: unknown): void {
    this.ensure();
    writeFileSync(this.pinsFile, JSON.stringify({ pins }, null, 2));
  }

  // ---- jsonl logs (spec §10.3 batched async flush) -------------------------

  appendJsonl(file: "metrics" | "prune-log", obj: unknown): void {
    try {
      const line = JSON.stringify(obj) + "\n";
      this.buffer.push({ file, line });
      if (this.buffer.length >= 50) {
        this.flush();
      } else if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          this.flush();
        }, 5000);
        if (typeof this.flushTimer.unref === "function") {
          this.flushTimer.unref();
        }
      }
    } catch {
      // fail-open
    }
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;
    const items = [...this.buffer];
    this.buffer = [];
    try {
      this.ensure();
      const metricsLines = items
        .filter((x) => x.file === "metrics")
        .map((x) => x.line)
        .join("");
      const pruneLines = items
        .filter((x) => x.file === "prune-log")
        .map((x) => x.line)
        .join("");
      if (metricsLines) {
        appendFileSync(this.metricsFile, metricsLines);
      }
      if (pruneLines) {
        appendFileSync(this.pruneLogFile, pruneLines);
      }
    } catch {
      // fail-open: drop if failed, don't crash
    }
  }

  readJsonl(file: "metrics" | "prune-log"): unknown[] {
    this.flush();
    try {
      const path = file === "metrics" ? this.metricsFile : this.pruneLogFile;
      if (!existsSync(path)) return [];
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      return lines.map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  // ---- checkpoints --------------------------------------------------------

  /** Next checkpoint number (cp-0001, cp-0002, ...). */
  nextCheckpointNumber(): number {
    try {
      const files = readdirSync(this.checkpointDir);
      let max = 0;
      for (const f of files) {
        const m = f.match(/^cp-(\d+)\.json$/);
        if (m) max = Math.max(max, Number(m[1]));
      }
      return max + 1;
    } catch {
      return 1;
    }
  }

  saveCheckpoint(cp: Checkpoint): { path: string; name: string } {
    this.ensure();
    const name = `cp-${String(this.nextCheckpointNumber()).padStart(4, "0")}.json`;
    const path = join(this.checkpointDir, name);
    writeFileSync(path, JSON.stringify(cp, null, 2));
    writeFileSync(join(this.checkpointDir, "latest.json"), JSON.stringify(cp, null, 2));
    return { path, name };
  }

  loadLatestCheckpoint(): Checkpoint | null {
    try {
      return JSON.parse(
        readFileSync(join(this.checkpointDir, "latest.json"), "utf8"),
      ) as Checkpoint;
    } catch {
      return null;
    }
  }

  listCheckpoints(): string[] {
    if (!existsSync(this.checkpointDir)) return [];
    return readdirSync(this.checkpointDir)
      .filter((f) => /^cp-\d+\.json$/.test(f))
      .sort();
  }
}
