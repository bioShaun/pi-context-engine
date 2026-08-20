# pi-context-engine — Specification v0.1

## 1. Overview

`pi-context-engine` 是一个面向 Pi Coding Agent 的上下文生命周期管理 extension。

它的目标不是单纯替代 Pi 原生 compaction，而是在 Pi 原生 context/compaction/handoff 能力之上增加一层策略控制：

```text
                   pi-context-engine
                          │
                          ▼
                  inspect context
                          │
                 pressure > threshold?
                    /           \
                  no             yes
                  │               │
                  ▼               ▼
               continue     classify context
                                │
                    ┌───────────┴───────────┐
                    ▼                       ▼
                low-value               high-value
             tool/history              state/reasoning
                    │                       │
                  prune                 checkpoint
                    │                       │
                    └──────────┬────────────┘
                               ▼
                       recompute pressure
                               │
                     ┌─────────┴─────────┐
                     ▼                   ▼
                  acceptable            high
                     │                   │
                  continue          compact / handoff
```

核心原则：

> Keep the working set, evict the noise, preserve recoverability.

系统应尽量避免让模型反复阅读低价值历史，同时保证：

- 用户需求不丢
- 关键约束不丢
- 当前任务状态不丢
- 已做出的架构决策不丢
- 修改过的文件不丢
- 测试状态不丢
- 可以从 compact 或 handoff 后恢复工作

---

# 2. Goals

## 2.1 Primary Goals

### G1 — Reduce context noise

自动识别并裁剪：

- 大量 shell stdout
- 重复 grep/search
- 已过期文件内容
- 已被后续版本覆盖的 diff
- 成功执行且无需再次参考的命令输出
- 重复 tool calls
- 大量 package install/build log
- 已解决错误的完整 traceback

目标：

```text
降低 token 消耗
+
提高 signal/noise ratio
+
提升模型在长 session 下的稳定性
```

---

### G2 — Preserve important state

必须可靠保存：

```text
Goal
Requirements
Constraints
Decisions
Current implementation state
Files touched
Verification status
Open issues
Next actions
```

这些信息不能依赖自由文本 conversation history 才能恢复。

---

### G3 — Smarter compaction

不能只有：

```text
if context > 90%:
    compact()
```

应该是：

```text
if pressure:
    prune()

if still_high:
    checkpoint()

if still_high:
    compact()

if context_quality_degraded or session_too_old:
    handoff()
```

---

### G4 — Recoverability

任何 destructive context operation 前必须存在可恢复状态。

例如：

```text
prune → original session remains available

compact → checkpoint exists

handoff → checkpoint + handoff prompt exists
```

---

### G5 — Work with Pi, not against Pi

尽量利用 Pi 原生：

```text
session
compaction
extension hooks
handoff
tool events
usage/context information
```

而不是重新实现一个 Agent runtime。

---

# 3. Non-Goals

v0.1 不负责：

- 长期用户 memory
- embedding/RAG 知识库
- 跨项目知识管理
- Planner/Worker/Reviewer orchestration
- 自动代码 review
- Git workflow 管理
- LSP
- MCP tool routing
- semantic code indexing

未来可以集成，但 Context Engine 本身只管理：

> 当前 session 的有效工作上下文。

---

# 4. Terminology

## Context

实际准备发送给 LLM 的消息集合。

---

## Context Pressure

当前上下文对模型 context window 的占用程度。

基础定义：

```text
pressure = estimated_context_tokens / usable_context_tokens
```

其中：

```text
usable_context_tokens =
    model_context_window
    - output_reserve
    - safety_reserve
```

---

## Working Set

当前任务仍然需要频繁使用的信息。

例如：

```text
当前需求
当前 plan
正在修改的代码
当前错误
用户约束
关键架构决定
当前 git diff
pending tests
```

---

## Stale Context

曾经有价值，但目前已经不再影响任务的信息。

例如：

```text
5 个 turn 前已经解决的 traceback
旧版本 src/foo.py
已经被新 patch 替代的 diff
重复的 repo exploration
```

---

## Disposable Context

删除后几乎不会影响后续任务的信息。

例如：

```text
npm install 正常输出
pytest 1000 个 PASS
git status 重复输出
ls 输出
编译 progress bar
```

---

## Checkpoint

Context Engine 生成的结构化任务状态。

Checkpoint 不是聊天摘要。

---

## Handoff

将当前任务状态转移到 fresh Pi session。

---

# 5. Architecture

建议分为六层：

```text
┌──────────────────────────────────────────────┐
│                 Pi Runtime                   │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│            Context Observer                  │
│ token / message / tool / age / relevance    │
└──────────────────────┬───────────────────────┘
                       ▼
┌──────────────────────────────────────────────┐
│           Context Classifier                 │
│ critical / working / stale / disposable     │
└──────────────────────┬───────────────────────┘
                       ▼
┌──────────────────────────────────────────────┐
│             Policy Engine                    │
│ keep / prune / summarize / checkpoint       │
│ compact / handoff                           │
└──────────────────────┬───────────────────────┘
                       ▼
┌──────────────────────────────────────────────┐
│             State Store                      │
│ checkpoints / pins / metadata / audit       │
└──────────────────────┬───────────────────────┘
                       ▼
┌──────────────────────────────────────────────┐
│             Context Rewriter                 │
│ build effective model context               │
└──────────────────────────────────────────────┘
```

---

# 6. Context Classification

这是整个系统最重要的部分。

v0.1 不建议一开始用 LLM 对每条消息做分类。

优先：

```text
rule-based
+
metadata
+
heuristics
```

后续再增加 semantic classifier。

每个 context item 应具备：

```ts
interface ContextItem {
  id: string

  type:
    | "user"
    | "assistant"
    | "tool-call"
    | "tool-result"
    | "system"
    | "summary"

  source?: string
  createdAt: number

  estimatedTokens: number

  importance: number
  freshness: number
  replaceability: number
  recoverability: number

  class:
    | "critical"
    | "working"
    | "stale"
    | "disposable"

  tags: string[]

  relatedFiles?: string[]
  relatedCommands?: string[]

  supersededBy?: string

  pinned: boolean
}
```

---

# 7. Classification Classes

## 7.1 CRITICAL

原则上禁止自动 prune。

包括：

```text
当前用户需求
用户显式约束
system instructions
项目级 instructions
当前任务目标
不可逆决策
pinned context
```

示例：

```text
“不要修改数据库 schema”

“保持 CLI backward compatible”

“只能修改 src/parser.py”

“不要提交 git commit”
```

---

## 7.2 WORKING

当前很可能仍然有用。

例如：

```text
最近正在修改的文件
当前 failing test
当前 traceback
最近 git diff
active plan
当前实现讨论
最近的 reviewer feedback
```

允许 compact，但通常不直接 prune。

---

## 7.3 STALE

曾经有用，但大概率已经被更新状态替代。

例如：

```text
旧版文件内容
旧 traceback
旧 diff
早期 repo exploration
已经完成的 TODO
被新 decision supersede 的讨论
```

优先 prune 或 summarize。

---

## 7.4 DISPOSABLE

默认允许删除。

例如：

```text
ls
pwd
成功 git status
npm progress
重复 grep
pytest PASS list
正常 build log
package manager download log
```

---

# 8. Importance Scoring

建议使用简单评分，而不是黑盒模型。

例如：

```text
importance_score =
    semantic_weight
  + recency_weight
  + user_weight
  + task_relevance
  + pin_bonus
  + failure_bonus
  - duplicate_penalty
  - superseded_penalty
  - verbosity_penalty
```

v0.1 可以直接规则化。

示例：

| 类型 | 基础 importance |
|---|---:|
| system | 100 |
| latest user request | 100 |
| pinned constraint | 100 |
| active failure | 90 |
| active diff | 85 |
| recent file read | 70 |
| assistant reasoning/result | 60 |
| successful tool output | 30 |
| duplicate tool output | 10 |
| install/build noise | 5 |

---

# 9. Context Pressure Levels

建议默认：

```yaml
pressure:
  green: 0.55
  yellow: 0.70
  orange: 0.82
  red: 0.90
```

策略：

## < 55%

```text
No action
```

---

## 55–70%

只做轻量清理：

```text
duplicate elimination
oversized tool-result compression
superseded output removal
```

---

## 70–82%

执行：

```text
aggressive stale pruning
+
tool-output folding
```

---

## 82–90%

执行：

```text
checkpoint
+
prune
+
optional compact
```

---

## >90%

优先：

```text
checkpoint
→ aggressive prune
→ compact
```

如果 compact 后依然高，或者 session 已多次 compact：

```text
handoff
```

---

# 10. Pruning Policy

## 10.1 Tool Output Folding

不要简单删除 tool result。

把：

```text
[bash output: 12,482 tokens]
```

替换成：

```text
[bash output pruned]

command:
pytest tests/

exit_code:
1

summary:
217 passed, 3 failed

important failures:
- test_parser.py::test_empty
- test_api.py::test_timeout
- test_config.py::test_invalid

original:
recoverable from session history
```

---

# 11. Tool-Specific Rules

## bash

以下类型 aggressive prune：

```text
npm install
pnpm install
pip install
uv sync
cargo build progress
docker build progress
nextflow download
wget/curl progress
```

保留：

```text
command
exit code
last relevant lines
errors
warnings
artifact locations
```

---

## read

如果同一个文件：

```text
read A@v1
edit A
read A@v2
```

则：

```text
A@v1 → stale
A@v2 → working
```

---

## grep/search

重复查询可以 fold：

```text
grep foo
grep foo
grep foo
```

只保留最近/最完整结果。

---

## tests

成功：

```text
pytest:
472 passed
```

失败：

保留 failure summary。

完整 traceback 只保留最新版本。

---

## git diff

只保留：

```text
current diff
```

旧 diff：

```text
stale
```

但 checkpoint 中记录历史操作。

---

# 12. Supersession

这是值得专门实现的机制。

例如：

```text
read src/a.py
↓
edit src/a.py
↓
read src/a.py
```

Context Engine 应知道：

```text
first read
    supersededBy
latest read
```

同样：

```text
pytest fail A
↓
fix
↓
pytest fail B
↓
fix
↓
pytest pass
```

前两个失败结果应降级为 stale。

---

# 13. Checkpoint Specification

Checkpoint 建议使用结构化 JSON/YAML。

内部推荐 JSON。

示例：

```json
{
  "version": 1,
  "created_at": "2026-08-20T20:00:00+08:00",

  "task": {
    "goal": "修复 Nextflow SNP filter 模块",
    "phase": "verification",
    "status": "in_progress"
  },

  "requirements": [
    "DP >= 10",
    "95% samples must pass",
    "保持现有 CLI"
  ],

  "constraints": [
    "不得修改输入 VCF",
    "不得改变现有 output naming"
  ],

  "decisions": [
    {
      "decision": "使用 bcftools expression 实现过滤",
      "reason": "避免新增 Python preprocessing",
      "status": "active"
    }
  ],

  "files": {
    "inspected": [
      "main.nf",
      "modules/filter.nf"
    ],

    "modified": [
      "modules/filter.nf"
    ],

    "created": [],

    "deleted": []
  },

  "verification": {
    "passed": [
      "nextflow config"
    ],

    "failed": [],

    "pending": [
      "small test dataset"
    ]
  },

  "issues": [
    {
      "description": "missing DP handling",
      "status": "open"
    }
  ],

  "next_actions": [
    "处理 missing DP",
    "运行 test dataset"
  ]
}
```

---

# 14. Checkpoint Generation

v0.1 可以让当前 LLM 生成 checkpoint。

但必须使用固定 schema。

不允许：

```text
“请总结一下目前进度”
```

应该：

```text
Produce a recovery checkpoint using exactly this schema.

Do not summarize conversational style.

Preserve:
- explicit user constraints
- unresolved issues
- implementation decisions
- verification status
- next executable actions
```

随后做 schema validation。

---

# 15. Pinning

支持：

```text
/context pin <text>
```

例如：

```text
/context pin 不要修改 database schema
```

也支持当前消息：

```text
/context pin-last
```

以及文件：

```text
/context pin-file src/parser.py
```

Pin 必须跨：

```text
prune
compact
checkpoint
handoff
```

保存。

---

# 16. Pin Data Structure

```ts
interface Pin {
  id: string

  type:
    | "constraint"
    | "requirement"
    | "file"
    | "command"
    | "note"

  content: string

  createdAt: number

  sourceMessageId?: string

  expires?: "session" | "task" | "manual"

  active: boolean
}
```

---

# 17. Handoff Policy

不建议单纯：

```text
pressure > 90%
→ handoff
```

建议计算：

```text
handoff_score
```

因素：

```text
context pressure
number of compactions
session age
tool-call count
stale ratio
checkpoint confidence
task phase boundary
```

例如：

```text
handoff if:

pressure > 0.90
AND compact_count >= 2
```

或者：

```text
task phase transition:
exploration → implementation
implementation → review
```

也可以建议 handoff。

---

# 18. Handoff Payload

Fresh session 不需要加载全部历史。

只加载：

```text
system/project instructions
+
latest checkpoint
+
pins
+
current git diff summary
+
necessary files
+
explicit next action
```

示例：

```text
You are continuing an existing coding task.

## Goal

Fix the Nextflow SNP filtering module.

## Hard constraints

- Keep CLI backward compatible.
- Do not modify source VCF.

## Current state

...

## Modified files

...

## Verification

...

## Next action

Run the small test dataset and investigate missing-DP behavior.

Continue directly from this state.
```

---

# 19. Compact vs Handoff

Context Engine 应明确区分。

## Compact

适合：

```text
任务仍处于同一个工作阶段
历史 discussion 很长
但当前 working set 仍清晰
```

---

## Handoff

适合：

```text
已经 compact 多次
session 累积大量历史垃圾
进入新的任务阶段
reasoning drift 明显
上下文很大但有效信息很少
```

原则：

> Compact preserves continuity.

> Handoff resets cognitive state.

---

# 20. Context Quality

除了 pressure，还建议增加：

```text
context_quality
```

定义：

```text
quality =
important_tokens / total_tokens
```

或者近似：

```text
signal ratio
```

例如：

```text
Context = 60%
```

不代表很好。

如果：

```text
40% 都是旧 bash output
```

则 quality 很差。

可以定义：

```yaml
quality:
  excellent: ">0.75"
  good: "0.55-0.75"
  poor: "0.35-0.55"
  critical: "<0.35"
```

最终策略应同时参考：

```text
pressure
+
quality
```

---

# 21. Decision Matrix

建议：

| Pressure | Quality | Action |
|---|---|---|
| Low | High | Nothing |
| Low | Poor | Background prune |
| Medium | High | Keep |
| Medium | Poor | Prune |
| High | High | Checkpoint + compact |
| High | Poor | Aggressive prune |
| Critical | High | Checkpoint + compact |
| Critical | Poor | Prune + handoff |

---

# 22. Commands

第一版建议只实现：

```text
/context
/context clean
/context checkpoint
/context compact
/context handoff
/context pin
/context pins
/context unpin
```

---

# 23. `/context`

输出：

```text
Context Engine

Model:
Qwen3.8-27B

Window:
262,144

Estimated usage:
181,320 / 245,760
73.8%

Quality:
57%

Classification:

critical       28.1K
working        62.4K
stale          53.7K
disposable     37.1K

Largest consumers:

1. bash:test          22.3K
2. read:src/parser.py 18.6K
3. bash:build         17.1K
4. old git diff       12.4K

Pins:
3

Compactions:
1

Recommendation:
PRUNE
Estimated reclaimable:
61K tokens
```

---

# 24. `/context clean`

执行：

```text
classify
→ prune disposable
→ prune stale
→ fold large tool outputs
→ rebuild effective context
```

然后报告：

```text
Before:
181K

After:
124K

Saved:
57K / 31.5%

Pruned:
18 tool results
7 superseded file reads
3 obsolete diffs
```

---

# 25. `/context checkpoint`

创建：

```text
.pi/context/checkpoints/
```

例如：

```text
.pi/context/checkpoints/
├── cp-0001.json
├── cp-0002.json
└── latest.json
```

如果不希望污染 repo，可以默认：

```text
~/.pi/context-engine/<session-id>/
```

推荐默认 session-local storage，不提交 Git。

---

# 26. Automatic Mode

配置：

```json
{
  "enabled": true,

  "thresholds": {
    "prune": 0.65,
    "checkpoint": 0.80,
    "compact": 0.88,
    "handoff": 0.94
  }
}
```

执行流程：

```ts
onContextPrepare(context) {
  const state = analyze(context)

  if (state.pressure >= pruneThreshold) {
    prune()
  }

  recompute()

  if (state.pressure >= checkpointThreshold) {
    checkpoint()
  }

  if (state.pressure >= compactThreshold) {
    requestCompact()
  }

  if (shouldHandoff(state)) {
    suggestHandoff()
  }
}
```

v0.1 建议：

> handoff 默认只建议，不自动执行。

因为 handoff 是 session-level 行为，自动执行可能影响用户体验。

---

# 27. Auto-Handoff Safety

默认：

```yaml
handoff:
  mode: suggest
```

未来支持：

```yaml
handoff:
  mode: auto
```

但只有：

```text
checkpoint successfully generated
AND
checkpoint validated
AND
pins persisted
```

才能执行。

---

# 28. Persistence

目录结构建议：

```text
~/.pi/context-engine/
└── sessions/
    └── <session-id>/
        ├── state.json
        ├── pins.json
        ├── metrics.jsonl
        ├── prune-log.jsonl
        └── checkpoints/
            ├── cp-0001.json
            └── cp-0002.json
```

---

# 29. Auditability

所有自动操作必须可检查。

例如：

```json
{
  "time": "...",
  "action": "prune",
  "item_id": "tool-187",
  "tool": "bash",
  "original_tokens": 12340,
  "replacement_tokens": 384,
  "reason": "superseded_test_failure"
}
```

核心原则：

> Never silently destroy context.

---

# 30. Recovery

提供：

```text
/context history
```

显示：

```text
#43 pruned bash output
#44 folded src/parser.py old read
#45 checkpoint cp-007
#46 compact
```

未来可以：

```text
/context restore 43
```

v0.1 可以暂不实现 restore，只需保证原始 Pi session history 没被物理删除。

---

# 31. Model Awareness

不同模型应支持不同策略。

配置：

```json
{
  "models": {
    "qwen*": {
      "prune": 0.55,
      "compact": 0.78
    },

    "claude*": {
      "prune": 0.65,
      "compact": 0.88
    },

    "gpt-*": {
      "prune": 0.65,
      "compact": 0.88
    }
  }
}
```

小模型通常需要更高 signal/noise ratio。

---

# 32. Token Estimation

v0.1 不需要做到 tokenizer 100% 精确。

允许：

```text
Pi-provided token usage
```

优先。

如果 unavailable：

```text
estimated tokens
```

即可。

关键是策略趋势正确，而不是每次精确到个位数。

---

# 33. Context Mutation Safety

这是实现时必须特别注意的一点。

多个 extension 可能同时修改 context。

因此 Context Engine 应遵循：

```text
read original
→ classify
→ produce transformation
→ return transformed context
```

避免直接 mutation shared message arrays。

尽量：

```ts
const transformed = structuredClone(context)
```

并保证自己的修改可重复执行：

> transformation should be idempotent.

---

# 34. Idempotency

例如已经 fold：

```text
[pi-context-engine:pruned id=123]
```

第二次不能再次 fold 成：

```text
[pruned pruned result...]
```

建议 replacement 带 metadata：

```text
<context-engine
  type="pruned-tool-result"
  source="tool-123"
  originalTokens="11200"
/>
```

内部 metadata 最好不要依赖可见字符串识别。

---

# 35. Concurrency

如果 Pi 允许并行 tools：

```text
tool A
tool B
tool C
```

Context Engine 必须基于：

```text
tool_call_id
```

关联：

```text
call ↔ result
```

不能假设严格串行。

---

# 36. Failure Handling

Context Engine 自己失败时：

```text
fail open
```

而不是 fail closed。

即：

```text
context-engine exception
↓
Pi 正常继续
```

绝不能因为 context extension bug 阻塞整个 Agent。

---

# 37. Performance Budget

Context analysis 不应明显降低交互速度。

目标：

```text
normal heuristic classification:

< 20 ms / turn
```

不包括 LLM checkpoint generation。

原则：

```text
fast path = deterministic

slow path = only checkpoint / semantic recovery
```

---

# 38. MVP

我建议你第一版只实现 **四件事**。

## MVP 1 — Context metrics

实现：

```text
/context
```

能看到：

```text
token usage
tool-output usage
largest context consumers
```

先不要改 context。

---

## MVP 2 — Tool pruning

只处理：

```text
bash
read
grep
```

规则：

```text
oversized
duplicate
superseded
```

实现：

```text
/context clean
```

---

## MVP 3 — Structured checkpoint

实现：

```text
/context checkpoint
```

固定 schema。

这是整个系统之后 compact/handoff 的基础。

---

## MVP 4 — Pressure policy

实现：

```text
65% prune
80% checkpoint
88% compact
```

先不自动 handoff。

做到这里已经能成为一个相当有价值的 Pi extension。

---

# 39. Recommended Implementation Phases

```text
Phase 1
Context Observer
        ↓
/context

Phase 2
Classifier
        ↓
Pruner
        ↓
/context clean

Phase 3
Checkpoint Store
        ↓
/context checkpoint

Phase 4
Policy Engine
        ↓
automatic prune

Phase 5
Pi compaction integration

Phase 6
handoff integration

Phase 7
semantic retrieval / context folding
```

不要反过来一开始就做 semantic memory。

---

# 40. Suggested Source Layout

```text
pi-context-engine/
├── package.json
├── README.md
├── src/
│   ├── index.ts
│   │
│   ├── config.ts
│   ├── types.ts
│   │
│   ├── observer/
│   │   ├── context-observer.ts
│   │   └── token-estimator.ts
│   │
│   ├── classifier/
│   │   ├── classifier.ts
│   │   ├── rules.ts
│   │   └── scoring.ts
│   │
│   ├── pruning/
│   │   ├── pruner.ts
│   │   ├── bash.ts
│   │   ├── read.ts
│   │   ├── grep.ts
│   │   └── supersession.ts
│   │
│   ├── checkpoint/
│   │   ├── checkpoint.ts
│   │   ├── schema.ts
│   │   └── store.ts
│   │
│   ├── policy/
│   │   ├── engine.ts
│   │   └── thresholds.ts
│   │
│   ├── handoff/
│   │   └── handoff.ts
│   │
│   ├── pins/
│   │   └── pins.ts
│   │
│   └── commands/
│       ├── context.ts
│       ├── clean.ts
│       ├── checkpoint.ts
│       ├── compact.ts
│       └── handoff.ts
│
└── tests/
    ├── classifier.test.ts
    ├── pruning.test.ts
    ├── supersession.test.ts
    ├── checkpoint.test.ts
    └── policy.test.ts
```

---

# 41. Core Interfaces

```ts
export interface ContextAnalysis {
  totalTokens: number
  usableTokens: number
  pressure: number

  criticalTokens: number
  workingTokens: number
  staleTokens: number
  disposableTokens: number

  quality: number
  reclaimableTokens: number

  items: ContextItem[]
}
```

```ts
export interface ContextPolicyDecision {
  action:
    | "none"
    | "prune"
    | "checkpoint"
    | "compact"
    | "handoff"

  reason: string

  pressureBefore: number
  estimatedPressureAfter?: number
}
```

```ts
export interface PruneResult {
  context: unknown[]

  removedTokens: number
  preservedTokens: number

  actions: PruneAction[]
}
```

---

# 42. Policy Pseudocode

```ts
async function manageContext(ctx: Context) {
  let analysis = analyzeContext(ctx)

  if (analysis.pressure < config.thresholds.prune) {
    return ctx
  }

  ctx = pruneDisposable(ctx)
  ctx = pruneSuperseded(ctx)

  analysis = analyzeContext(ctx)

  if (analysis.pressure < config.thresholds.checkpoint) {
    return ctx
  }

  await ensureCheckpoint(ctx)

  if (analysis.pressure < config.thresholds.compact) {
    return ctx
  }

  await requestCompaction()

  analysis = analyzeContext(ctx)

  if (shouldHandoff(analysis)) {
    suggestHandoff()
  }

  return ctx
}
```

---

# 43. Better Policy

实际实现时不要只看 threshold。

推荐：

```ts
function decide(a: ContextAnalysis): Decision {
  if (a.pressure < 0.55 && a.quality > 0.60)
    return NONE

  if (a.reclaimableTokens > 20_000)
    return PRUNE

  if (a.pressure > 0.80 && !checkpointFresh())
    return CHECKPOINT

  if (a.pressure > 0.88)
    return COMPACT

  if (
    a.pressure > 0.90 &&
    compactCount >= 2 &&
    a.quality < 0.50
  )
    return HANDOFF

  return NONE
}
```

---

# 44. Metrics

建议从第一版就记录。

```text
context_tokens_before
context_tokens_after

tokens_pruned

tool_tokens_pruned

compaction_count

checkpoint_count

handoff_count

context_quality

reclaimable_tokens
```

最重要的一个指标：

```text
context reduction ratio
```

但未来真正应该关注：

```text
task success
```

不能为了压 token 把 Agent 压傻。

---

# 45. Evaluation

至少准备以下测试 session：

### Case A — Huge test output

```text
pytest produces 30K tokens
```

期望：

```text
保留 failure summary
删除无关 PASS output
```

---

### Case B — Repeated file reads

```text
read file
edit
read
edit
read
```

期望：

```text
旧版本自动 stale
最新版本 working
```

---

### Case C — User constraint survives compact

用户早期说：

```text
不要改变 CLI
```

经过：

```text
50 turns
prune
checkpoint
compact
```

仍必须存在。

---

### Case D — Old errors disappear

```text
error A
fix A
error B
fix B
pass
```

最终 context 不应继续携带 A/B 完整 traceback。

---

### Case E — Handoff recovery

handoff 后 Agent 应准确回答：

```text
当前目标是什么？
修改了哪些文件？
还有什么没完成？
有哪些禁止事项？
下一步是什么？
```

---

# 46. Acceptance Criteria — MVP

满足以下条件即可发布 `v0.1`：

- `/context` 可以展示当前压力和最大 context consumer
- 可检测 oversized tool output
- 可检测明显 duplicate tool output
- 可检测 superseded file reads
- `/context clean` 可安全减少 context
- 原 session 数据不被物理删除
- `/context checkpoint` 可产生合法 structured state
- 用户 pins 永不被 prune
- extension error 不阻塞 Pi
- 自动 prune 可关闭
- compact 可关闭
- 所有自动行为有 audit log

---

# 47. v0.2

增加：

```text
automatic checkpoint
Pi compaction hook
better test-result folding
git-aware diff tracking
task phase detection
```

---

# 48. v0.3

增加：

```text
handoff scoring
automatic fresh-session bootstrap
checkpoint recovery
```

---

# 49. v0.4

开始尝试：

```text
semantic folding
```

即：

```text
context item
↓
fold
↓
short representation
↓
recall on demand
```

这里才需要考虑 embedding / semantic retrieval。

---

# 50. Long-Term Architecture

最终理想状态：

```text
                         LLM
                          ▲
                          │
                  Active Working Set
                          ▲
                          │
            ┌─────────────┴──────────────┐
            │                            │
      Context Engine               Recall Engine
            │                            ▲
     ┌──────┼──────┐                     │
     │      │      │                     │
   prune  compact checkpoint          cold context
     │      │      │                     │
     └──────┴──────┴─────────────────────┘
                          │
                     Session Store
```

这实际上就是一个：

> Agent Context Virtual Memory System

对应关系：

```text
LLM context window       → RAM

active messages          → working set

old session history      → cold storage

prune                    → page eviction

checkpoint               → process state

recall                    → page fault

compact                   → memory compression

handoff                   → process restart with restored state
```

---

# 51. Design Principle

实现过程中始终遵循以下优先级：

```text
Correctness
    >
Recoverability
    >
Context quality
    >
Token savings
```

不要变成：

```text
为了省 30K token
把一个关键用户约束删了
```

宁可多保留 20K token，也不要误删重要 context。

因此初始版本：

```text
precision > recall
```

换句话说：

> 只有高度确定是垃圾的内容才自动 prune。

---

# 52. Recommended First Implementation Target

如果你准备马上开始写，我建议第一个 milestone 不超过：

```text
/context
+
ContextAnalysis
+
ToolResultClassifier
+
/context clean
```

先做到：

```text
Pi session
   ↓
identify 50K garbage tokens
   ↓
safe prune
   ↓
Agent behavior unchanged
```

一旦这个 MVP 稳定，再加：

```text
checkpoint
→ compact integration
→ handoff
```

不要第一版就实现完整的“智能 Context OS”。

---

# 53. Definition of Success

`pi-context-engine` 成功，不是因为：

```text
context 从 180K 压成 70K
```

而是：

```text
在长时间 coding session 中：

更少的 context
+
更少的信息遗忘
+
更少的 reasoning drift
+
更少的重复探索
+
compact 后仍能继续工作
+
handoff 后几乎无感恢复
```

最终目标：

> **让 Pi 的有效上下文长度，明显大于模型的物理上下文长度。**

不是通过扩大 context window，而是通过始终只让模型看到当前任务真正需要的 working set。