import type { EngineState } from "./types.ts";
import type { SessionStore } from "./checkpoint/store.ts";

export const DEFAULT_STATE: EngineState = {
  compactionCount: 0,
  checkpointCount: 0,
  handoffCount: 0,
  lastPruneAt: 0,
  lastCheckpointAt: 0,
  lastCompactAt: 0,
};

export function loadState<T extends EngineState>(store: SessionStore): T | undefined {
  const raw = store.loadState<{ state?: T }>();
  const s = raw?.state;
  if (!s) return undefined;
  return { ...DEFAULT_STATE, ...s } as T;
}

export function saveState(store: SessionStore, state: EngineState): void {
  store.saveState({ state, updatedAt: new Date().toISOString() });
}
