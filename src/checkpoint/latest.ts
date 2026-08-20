/**
 * Locate the latest checkpoint for a session (spec §25).
 */

import { join } from "node:path";

export function getCheckpointDir(stateDir: string, sessionId: string): string {
  return join(stateDir, "sessions", sessionId, "checkpoints");
}

export function getLatestCheckpointPath(stateDir: string, sessionId: string): string {
  return join(getCheckpointDir(stateDir, sessionId), "latest.json");
}
