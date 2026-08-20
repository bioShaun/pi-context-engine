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

  // ---- jsonl logs ---------------------------------------------------------

  appendJsonl(file: "metrics" | "prune-log", obj: unknown): void {
    this.ensure();
    const path = file === "metrics" ? this.metricsFile : this.pruneLogFile;
    writeFileSync(path, JSON.stringify(obj) + "\n", { flag: "a" });
  }

  readJsonl(file: "metrics" | "prune-log"): unknown[] {
    try {
      const lines = readFileSync(file === "metrics" ? this.metricsFile : this.pruneLogFile, "utf8")
        .split("\n")
        .filter(Boolean);
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
