/**
 * Supersession detection (spec §12).
 *
 * Groups tool-result messages by (tool, identity key). Within a group that
 * has multiple members, every member except the LAST is superseded:
 *
 *   read src/a.py  →  edit src/a.py  →  read src/a.py
 *   group [r1, r2]: r1 supersededBy r2
 *
 *   pytest tests/ (fail A)  →  pytest tests/ (fail B)  →  pytest tests/ (pass)
 *   group [f1, f2, p]:      f1, f2 supersededBy p
 *
 * Built purely on toolCallId correlation — safe under parallel tools (§35).
 */

import type { AnyMessage, ResolvedToolCall } from "../types.ts";
import { normalizeCommand, testGroupKey, categorizeCommand } from "./bash.ts";
import { readGroupKey, getReadRange, readRangesOverlap, type ReadRange } from "./read.ts";
import { searchGroupKey } from "./grep.ts";

export interface SupersessionGroup {
  key: string;
  tool: string;
  /** messageIndexes of the group members, in context order. */
  memberIndexes: number[];
  label: string;
}

export interface SupersessionInfo {
  /** messageIndex → group (only for members that ARE superseded). */
  superseded: Map<number, SupersessionGroup>;
  /** All groups (for reports). */
  groups: SupersessionGroup[];
}

export function groupKeyForCall(call: ResolvedToolCall): string | undefined {
  const name = call.name;
  if (name === "read") return readGroupKey(call);
  if (name === "grep" || name === "find" || name === "ls")
    return searchGroupKey(call);
  if (name === "bash") {
    const cmd = String(call.args.command ?? "");
    const cat = categorizeCommand(cmd);
    if (cat === "test") return testGroupKey(cmd);
    // bash duplicates: only exact normalized-command repeats group together.
    // (Different invocations are distinct work; never merge.)
    const n = normalizeCommand(cmd);
    return n ? `bash:${n}` : undefined;
  }
  return undefined;
}

/**
 * Compute supersession info across the effective message list.
 *
 * `toolCalls` maps toolCallId → resolved call. toolResult messages without a
 * resolvable call simply do not group (conservative).
 */
export function computeSupersession(
  messages: readonly AnyMessage[],
  toolCalls: Map<string, ResolvedToolCall>,
): SupersessionInfo {
  const groups = new Map<string, SupersessionGroup>();
  const readOccurrences = new Map<
    string,
    Array<{ index: number; call: ResolvedToolCall; range: ReadRange }>
  >();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "toolResult") continue;
    const call = msg.toolCallId ? toolCalls.get(msg.toolCallId) : undefined;
    if (!call) continue;

    if (call.name === "read") {
      const key = readGroupKey(call);
      if (key) {
        let occ = readOccurrences.get(key);
        if (!occ) {
          occ = [];
          readOccurrences.set(key, occ);
        }
        occ.push({ index: i, call, range: getReadRange(call) });
      }
      continue;
    }

    const key = groupKeyForCall(call);
    if (!key) continue;

    let group = groups.get(key);
    if (!group) {
      group = { key, tool: call.name, memberIndexes: [], label: key };
      groups.set(key, group);
    }
    group.memberIndexes.push(i);
  }

  const superseded = new Map<number, SupersessionGroup>();
  const all: SupersessionGroup[] = [];

  // Non-read tool groups
  for (const group of groups.values()) {
    all.push(group);
    if (group.memberIndexes.length <= 1) continue;
    const last = group.memberIndexes[group.memberIndexes.length - 1];
    for (const idx of group.memberIndexes) {
      if (idx !== last) superseded.set(idx, group);
    }
  }

  // Read tool supersession with range overlap check (spec §8.2)
  for (const [key, occ] of readOccurrences.entries()) {
    const group: SupersessionGroup = {
      key,
      tool: "read",
      memberIndexes: occ.map((o) => o.index),
      label: key,
    };
    all.push(group);

    if (occ.length <= 1) continue;

    for (let i = 0; i < occ.length - 1; i++) {
      const earlier = occ[i];
      // Check if any later read of this file supersedes this earlier read
      for (let j = i + 1; j < occ.length; j++) {
        const later = occ[j];
        if (later.range.isFull || readRangesOverlap(earlier.range, later.range)) {
          superseded.set(earlier.index, {
            ...group,
            memberIndexes: [earlier.index, later.index],
          });
          break;
        }
      }
    }
  }

  return { superseded, groups: all };
}
