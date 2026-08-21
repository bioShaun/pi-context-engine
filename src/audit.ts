/**
 * Auditability (spec §29): every automatic behavior is logged.
 * "Never silently destroy context."
 *
 * Also holds the per-session EngineState (spec §44 metrics).
 */

import type { AuditEvent, EngineState, PruneAction } from "./types.ts";
import type { SessionStore } from "./checkpoint/store.ts";
import { DEFAULT_STATE, loadState, saveState } from "./state.ts";

export class Auditor {
  private store: SessionStore;
  constructor(store: SessionStore) {
    this.store = store;
  }

  event(action: string, data: Record<string, unknown> = {}): void {
    const ev: AuditEvent = { time: new Date().toISOString(), action, ...data };
    try {
      this.store.appendJsonl("metrics", ev);
    } catch {
      // fail-open: audit must never break the agent
    }
  }

  prune(actions: PruneAction[], mode: "auto" | "manual", tokensBefore: number, tokensAfter: number): void {
    try {
      for (const a of actions) {
        this.store.appendJsonl("prune-log", {
          time: new Date().toISOString(),
          action: a.kind,
          item_id: a.messageId,
          tool: a.tool,
          mode,
          original_tokens: a.originalTokens,
          replacement_tokens: a.replacementTokens,
          reason: a.reason,
          tags: a.tags,
        });
      }
      this.event("prune", {
        mode,
        actions: actions.length,
        tokens_before: tokensBefore,
        tokens_after: tokensAfter,
        saved: tokensBefore - tokensAfter,
      });
    } catch {
      // fail-open
    }
  }

  metric(data: Record<string, unknown>): void {
    this.event("metric", data);
  }

  flush(): void {
    try {
      this.store.flush();
    } catch {
      // fail-open
    }
  }
}

export function getState(store: SessionStore): EngineState {
  return loadState<EngineState>(store) ?? DEFAULT_STATE;
}

export function putState(store: SessionStore, state: EngineState): void {
  saveState(store, state);
}
