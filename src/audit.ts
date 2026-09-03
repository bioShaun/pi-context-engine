/**
 * Auditability (spec §29): every automatic behavior is logged.
 * "Never silently destroy context."
 *
 * Also holds the per-session EngineState (spec §44 metrics).
 */

import type { AuditEvent, EngineState, PruneAction } from "./types.ts";
import type { SessionStore } from "./checkpoint/store.ts";
import { DEFAULT_STATE, loadState, saveState } from "./state.ts";

function shortRecoveryId(ref: { contentHash?: string }): string | null {
  const m = (ref?.contentHash ?? "").match(/:([0-9a-f]{3,})$/);
  return m ? `r:${m[1].slice(0, 6)}` : null;
}

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
          // v0.3 (pi-native-recall spec §6.3, §12.4): recovery + ordering fields
          level: a.level,
          recovery: a.recovery,
          recovery_unavailable: a.recoveryUnavailable,
          tool_call_id: a.toolCallId,
          message_position: a.messageIndex,
          reclaimable_tokens: a.reclaimableTokens,
          cache_locality: a.cacheLocality !== undefined ? Number(a.cacheLocality.toFixed(4)) : undefined,
          selected_rank: a.selectedRank,
        });
      }
      this.event("prune", {
        mode,
        actions: actions.length,
        tokens_before: tokensBefore,
        tokens_after: tokensAfter,
        saved: tokensBefore - tokensAfter,
      });
      // v0.3 per-action events (spec §16)
      for (const a of actions) {
        if (a.kind === "stub" && (a.stubFacts?.length ?? 0) > 0) {
          this.event("stub_enhanced", {
            tool: a.tool,
            facts: a.stubFacts,
            original_tokens: a.originalTokens,
            replacement_tokens: a.replacementTokens,
            recovery_id: a.recovery ? shortRecoveryId(a.recovery) : null,
          });
        }
        if (a.recoveryUnavailable) {
          this.event("recovery_ref_unavailable", {
            item_id: a.messageId,
            tool: a.tool,
            reason: a.recoveryUnavailable,
          });
        }
      }
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
