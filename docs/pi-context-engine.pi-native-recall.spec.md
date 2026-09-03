# pi-context-engine — Pi 原生压缩与召回优化 Spec

> 状态：Draft  
> 前置文档：`pi-context-engine.spec.md`（v0.1）、`pi-context-engine.auto-optimization.spec.md`（v0.2）。  
> 本文档定义增强 stub、上下文召回、前缀缓存感知、分层可逆 folding 和瞬态指导。实现范围严格限定为 **Pi Coding Agent 原生 extension**。

---

# 1. 背景

v0.2 已具备规则分类、自动 prune、结构化 checkpoint、原生 compact、pins、handoff 建议和完整审计。当前 prune 仍有两个闭环缺口：

1. 一行 stub 只说明「内容被裁剪」，没有保留足够的结果事实；模型经常只能重新执行命令。
2. 原始工具结果虽然仍在 Pi session 中，但没有面向用户和模型的检索入口；“未删除”不等于“可发现”。

此外，当前候选选择没有显式考虑 provider 前缀缓存，fold 只有单层 head/error/tail，指导性状态主要通过持久消息或 UI 呈现。

本优化把 prune 从“安全缩短文本”扩展为完整闭环：

```text
Pi session 原始条目（事实源，永不改写）
            │
            ├── context event ──► classify ──► fold/stub ──► effective context
            │                                      │
            │                                      └── recovery ref
            │
            └── current branch scan ──► context_search / /context search
```

核心原则：**先保证可召回，再增加压缩深度。**

---

# 2. 目标

## G1 — 信息密集的确定性 stub

stub 必须在严格长度预算内保留最重要、可机器提取的事实，例如 exit code、错误签名、结果计数、读取范围和 HTTP 状态。

不得为了生成 stub 发起 LLM 调用。

## G2 — 被裁剪内容可检索

同时提供：

- 用户命令：`/context search <query>`；
- Pi 原生模型工具：`context_search`。

两者必须调用同一个召回引擎，并从当前 Pi session branch 的原始条目读取内容。

## G3 — 前缀缓存友好

当多个 prune 候选的价值和收益接近时，优先改写靠后的条目，减少 provider 前缀缓存失效范围。

缓存收益只能作为次级排序因素，不能阻止高收益、低风险的早期裁剪。

## G4 — 分层、可追溯、可恢复的 folding

每个 fold/stub 必须携带稳定来源引用。后续允许按压力逐层缩短，但任何层都能通过召回引擎定位原始 Pi session 条目。

## G5 — 指导信息瞬态化

压力、推荐动作、召回提示等指导性内容只对当前 agent turn 生效，不写入永久会话历史。

用户约束、pins、checkpoint 和任务事实不得依赖瞬态注入。

## G6 — 保持热路径和安全模型

继承现有约束：

- fail-open；
- non-destructive；
- provider tool-call pairing 不变；
- idempotent；
- never enlarge；
- precision > recall；
- `context` 热路径 p95 < 20ms；
- 零新增运行时依赖。

---

# 3. Non-Goals

本文档明确不包含：

- 通用 LLM API proxy；
- Anthropic/OpenAI wire protocol 改写；
- MITM、CA、base URL 路由；
- Plugin + Proxy 双层通信；
- 跨 Claude Code、Codex、Cursor、Aider 等宿主适配；
- 通用工具 manifest 或远端 compression authority；
- 跨 session 全局搜索；
- 云端索引或遥测上传；
- 首版 embedding/vector database；
- 自动恢复并重新注入完整原文；
- 用 LLM 生成每条 stub 或 fold。

不得为了未来可能的通用代理化预留抽象层。只抽取当前 Pi 实现中存在两个以上调用者的纯逻辑。

---

# 4. 设计原则

### P1 — Pi session 是唯一事实源

原始工具输出保留在 Pi session branch。引擎不得复制完整输出到 `prune-log.jsonl`、独立数据库或第二份 session 文件。

### P2 — Retrieval before compression

任何新的有损压缩层级上线前，必须先有覆盖该层的召回路径和验收测试。

### P3 — Extractive before generative

能从结构字段或文本模式确定提取的事实，禁止使用 LLM。语义摘要只允许用于后续高压力 folding，且必须有预算、退避和原文引用。

### P4 — Cache is an optimization, not correctness

前缀缓存不得改变 critical/pinned/active-failure 的安全规则，也不得覆盖明显更高的 token 回收收益。

### P5 — Explicit model access

`/context search` 只解决用户主动检索；模型自助召回必须通过 Pi 原生 `registerTool()` 注册的 `context_search` 完成，不能假设模型能调用 slash command。

### P6 — No hidden persistence

召回默认按需扫描当前 branch。可以建立 session 生命周期内的内存索引，但 session 切换、fork、compact 或 shutdown 时必须失效；不得静默持久化原文。

---

# 5. Pi 原生架构

## 5.1 Pi API 使用

只使用 Pi extension 已提供的原生能力：

| 能力 | Pi API | 用途 |
|---|---|---|
| 有效上下文改写 | `pi.on("context")` | 应用 fold/stub |
| 原始分支读取 | `ctx.sessionManager.getBranch()` | 构建召回源 |
| 有效条目回退 | `ctx.sessionManager.buildContextEntries()` | branch 读取失败时降级 |
| 模型召回工具 | `pi.registerTool()` | 注册 `context_search` |
| 用户命令 | `pi.registerCommand("context")` | `/context search` |
| 瞬态 system prompt | `pi.on("before_agent_start")` | 当前 turn 指导 |
| 非上下文状态 | `pi.appendEntry()` 或现有 store | 仅保存小型元数据，不保存原文 |

不得通过代理、网络服务或子进程完成上述能力。

## 5.2 推荐模块边界

```text
src/pruning/stub-summary.ts     # 确定性事实提取和预算渲染
src/pruning/pruner.ts           # plan、替换、安全检查
src/recall/source.ts            # Pi branch → SearchDocument
src/recall/search.ts            # 纯词法匹配、排序、snippet
src/recall/tool.ts              # context_search 原生工具定义
src/transient/guidance.ts       # 当前 turn 的短指导文本
```

`source.ts` 是 Pi-specific adapter；`search.ts` 只保存纯函数，便于测试。不得建立“通用 agent adapter”接口。

---

# 6. 稳定恢复引用

## 6.1 问题

当前 `ContextItem.id` 基于 `messageIndex` 和文本前缀生成。compaction、branch 变化或上下文重建后 index 可能变化，因此它适合单轮分类和审计，不足以作为长期恢复引用。

## 6.2 RecoveryRef

新增：

```ts
interface RecoveryRef {
  version: 1;
  sessionId: string;
  branchEntryId?: string;
  toolCallId?: string;
  messageTimestamp?: number;
  contentHash: string;
}
```

解析优先级：

1. `branchEntryId`；
2. `toolCallId + contentHash`；
3. `messageTimestamp + contentHash`；
4. 仅 `contentHash`，且必须唯一命中。

`contentHash` 使用现有确定性 hash 工具对完整原始文本计算。它用于定位和冲突检测，不用于安全认证。

## 6.3 engine details 扩展

fold/stub 的 `details` 增加：

```ts
{
  engine: "pi-context-engine",
  kind: "stub" | "fold",
  level: 1 | 2 | 3,
  tool: string,
  reason: string,
  originalTokens: number,
  replacementTokens: number,
  recovery: RecoveryRef,
  at: string
}
```

现有字段保持兼容。`level` 缺失按 `1` 处理。

对应的 `prune-log.jsonl` 记录必须增加 `recovery`，使 `scope: "pruned"` 能从审计记录稳定关联回 L0。不得只保存当前基于 message index 的 `item_id`；旧日志没有 `recovery` 时按兼容模式处理，搜索可退化为 `scope: "all"` 并标记 prune metadata unavailable。

## 6.4 失败语义

无法构建稳定 `RecoveryRef` 时：

- 允许沿用现有单层确定性 fold；
- 禁止生成更激进的 level 2/3 摘要；
- stub 文本不得宣称可以通过 recovery ID 恢复；
- 写审计事件 `recovery_ref_unavailable`；
- 整个 agent 流程继续，保持 fail-open。

---

# 7. 增强 stub

## 7.1 数据结构

```ts
interface StubFacts {
  status?: "success" | "failure" | "cancelled" | "unknown";
  exitCode?: number | null;
  errorCount?: number;
  warningCount?: number;
  resultCount?: number;
  lineCount?: number;
  byteCount?: number;
  path?: string;
  range?: { start?: number; end?: number };
  command?: string;
  errorSignature?: string;
  recoveryId?: string;
}
```

所有字段必须来自消息结构、工具参数或确定性文本匹配。禁止推断未出现的状态。

## 7.2 工具提取规则

### Bash / bashExecution

按优先级保留：

1. `cancelled`；
2. `exitCode`；
3. 失败时首个高置信错误签名；
4. test/build 输出中的 passed/failed/error 计数；
5. 原始行数；
6. 截断后的 command，仅在预算允许时保留。

错误签名复用并收紧 `foldBashOutput` 的错误行规则。最多一条，去除 ANSI，合并空白，禁止超过配置上限。

### read

保留：

- 规范化 path；
- offset/limit 对应的行区间；
- 原始行数或字符数；
- 是否为完整读取。

不得把文件正文复制进 stub。

### grep / find / ls

保留：

- 查询 pattern 或目标 path 的短形式；
- 命中数；
- 命中文件数（能确定时）；
- 截断状态。

不得枚举完整命中列表。

### fetch / 网络类工具

仅当结构字段或输出中有高置信匹配时保留：

- hostname 或截断 URL；
- HTTP status；
- content type；
- response byte count。

不得在 stub 中保留 query secret、Authorization、cookie 或疑似 token。

### 未识别工具

只保留 tool 名、原 token 数、reason 和 recovery ID；不做自由文本摘要。

## 7.3 渲染格式

统一为单行：

```text
[pi-context-engine] <tool> pruned: <facts>; ~<tokens> tokens; reason=<reason>; recover=<id>
```

示例：

```text
[pi-context-engine] bash pruned: exit=1, errors=3, first="TS2322: Type 'string' is not assignable to type 'number'", lines=428; ~6.2K tokens; recover=r:8af1c2
```

```text
[pi-context-engine] read pruned: src/index.ts lines 1-240, 240 lines; ~3.1K tokens; reason=superseded; recover=r:31db09
```

事实为空时退化为现有通用 stub，不输出空字段。

## 7.4 长度预算

默认约束：

```text
maxStubChars = min(360, floor(originalChars * 0.20))
replacementTokens + safetyMargin(24) < originalTokens
```

预算不足时按以下顺序删除：

1. command / pattern；
2. warningCount；
3. lineCount / byteCount；
4. reason 细节，退化为短 reason code；
5. errorSignature 截短但不得改变错误码；
6. 保留 tool、status/exitCode、原 token 数和 recovery ID。

如果最短合法 stub 仍不节省 token，保持原内容不变。

## 7.5 安全

- 所有换行折叠为空格，避免 stub 伪造多行结构；
- ANSI/control characters 删除；
- secret-like 片段必须 redact；
- `errorSignature` 只取一行，不拼接任意上下文；
- stub 生成异常时回退现有通用 stub，再执行 never-enlarge 检查。

---

# 8. 召回源

## 8.1 SearchDocument

```ts
interface SearchDocument {
  recovery: RecoveryRef;
  entryId?: string;
  toolCallId?: string;
  tool: string;
  command?: string;
  argsText?: string;
  content: string;
  timestamp: number;
  estimatedTokens: number;
  prune?: {
    kind: "stub" | "fold";
    reason: string;
    at: string;
  };
}
```

## 8.2 构建流程

每次显式搜索：

1. 调用 `ctx.sessionManager.getBranch()`；
2. 仅遍历当前 branch 的 message/tool result/bash execution 条目；
3. 以 assistant tool call 的显式 `toolCallId` 关联参数和结果；
4. 读取 `prune-log.jsonl`，给已裁剪条目附加 prune metadata；
5. 构建 `SearchDocument[]`；
6. 搜索结束后释放原文数组，除非启用当前 session 的有界内存缓存。

不得搜索其他 branch 或其他 session。

必须排除引擎自身生成的 `context_search` 工具结果、search `--send` 消息、瞬态指导和已有 stub/fold 文本；召回源只能是对应的 L0 原始工具结果。该规则防止 snippet 被再次索引、排序自我强化和敏感片段重复扩散。

## 8.3 Compaction 后行为

Pi 原始 branch 若仍包含 compact 前条目，召回必须覆盖这些条目，并在结果上标记 `pre-compaction`。

若当前 Pi 版本的 branch API 不再暴露 compact 前原文：

- 返回可用的当前 branch 结果；
- 明确显示 `history coverage is partial after compaction`；
- 不得用 checkpoint 或摘要冒充原始命中；
- 写审计事件 `search_coverage_partial`。

不得为规避该限制复制完整历史。

## 8.4 内存缓存

首版默认不缓存，按需扫描。只有实测单次搜索 p95 超过 100ms，才允许增加 session 内存索引。

内存索引必须在以下事件失效：

- `session_start`；
- `session_before_switch` / `session_info_changed`；
- `session_compact`；
- `session_before_fork`；
- 新工具结果进入 session；
- `session_shutdown`。

---

# 9. 词法召回

## 9.1 查询语义

首版支持：

```text
/context search <free text>
/context search "exact phrase"
/context search tool:bash <free text>
/context search file:src/index.ts <free text>
```

`context_search` 工具参数：

```ts
{
  query: string;              // required, 1..500 chars
  limit?: number;             // default 8, range 1..20
  tool?: string;
  scope?: "pruned" | "all"; // default "pruned"
}
```

空查询、超长查询或非法 limit 返回结构化错误，不扫描 session。

## 9.2 归一化

- Unicode NFKC；
- locale-independent lowercase；
- 连续空白合并；
- 保留路径分隔符、错误码中的 `- _ . / :`；
- CJK 以 unigram + bigram 匹配；
- Latin 文本以 token + exact substring 匹配；
- quoted phrase 必须连续匹配。

## 9.3 排序

无需引入 BM25 依赖。采用确定性加权：

```text
score =
  12 * exactPhraseHits
+  6 * errorCodeHits
+  5 * pathHits
+  4 * commandHits
+  3 * contentTokenHits
+  2 * toolFilterMatch
+      recencyBonus
```

规则：

- 所有非 stop-word 查询 token 默认必须命中；
- quoted phrase 不命中则淘汰；
- 同分时：pruned 优先、较新条目优先、branch entry 顺序靠后优先；
- 不因文档更长而无限加分；每类 hit 需要 cap；
- score 实现必须是纯函数、稳定排序。

## 9.4 Snippet

每条结果最多返回：

- 1 个主要命中窗口；
- 命中前后各 2 行；
- 总计最多 800 chars；
- 保留行号；
- secret-like 内容 redact；
- 原文更长时显示 omitted line count。

模型工具所有结果合计默认不得超过约 3,000 tokens。超过预算时先减少 snippet，再减少结果数。

## 9.5 无结果

返回：

- 标准化后的 query；
- 实际搜索 document 数；
- 当前 coverage（complete/partial）；
- 0 results；
- 一条缩短查询或改用 `scope: "all"` 的建议。

不得自动执行原命令或读取文件。

---

# 10. Pi 原生 `context_search` 工具

## 10.1 注册

通过 `pi.registerTool()` 注册：

```text
name: context_search
label: Search pruned context
description: Search original tool outputs preserved in the current Pi session branch.
executionMode: parallel
```

参数使用 Pi 已有 TypeBox 依赖提供的 schema；项目不得新增 schema runtime dependency。

## 10.2 模型指导

`promptSnippet` 只说明该工具可检索被 fold/stub 的旧工具输出。

`promptGuidelines` 限定：

- 当 stub 中的事实不足以继续任务时先搜索；
- 查询应包含错误码、文件路径、命令片段或唯一术语；
- 不要为了“可能有用”而浏览全部历史；
- 搜索无结果时再考虑重新执行工具。

这些文字必须短且稳定，避免每轮改变 system prompt 前缀。

## 10.3 工具结果

返回普通 Pi `AgentToolResult`，文本包含 compact results；`details` 包含结构化 hit metadata，供 UI renderer 使用。

工具本身只读，不触发 agent turn 外的隐藏消息，不修改 session，不自动 pin 命中内容。

## 10.4 并发

搜索读取 branch 快照后只处理本地不可变数组，可以与其他只读工具并行。若 Pi session API 不能提供一致快照，则改为 `sequential`，正确性优先。

AbortSignal 被触发时必须尽快停止扫描并返回取消结果，不写错误审计。

---

# 11. `/context search` 命令

## 11.1 行为

```text
/context search <query>
```

- 使用与 `context_search` 完全相同的 parser、search 和 renderer；
- 默认 `scope=pruned`、`limit=8`；
- 在 Pi UI 显示命中摘要；
- 不自动触发模型 turn；
- 不把完整命中写进永久消息历史。

如果用户需要让模型立即处理结果，显式使用：

```text
/context search <query> --send
```

`--send` 只发送已经按总 token 预算截断和脱敏后的结果，使用 Pi `sendMessage` 的 next-turn/steer 语义；不得发送完整原文。

## 11.2 命令帮助

更新：

- command description；
- argument completions；
- unknown subcommand 帮助；
- README 中 Commands 表；
- `/context history` 对 search 审计事件的展示。

---

# 12. 前缀缓存感知排序

## 12.1 适用边界

现有 `planForItem` 继续决定 keep/stub/fold；缓存评分不得改变该 plan。它只在多个可执行 action 中决定处理顺序，尤其在存在目标回收量或动作上限时。

## 12.2 候选评分

建议：

```ts
interface PruneCandidateScore {
  safety: number;          // class/pin/active failure，最高优先级
  reclaimable: number;     // original - replacement
  disposability: number;   // disposable > stale > working
  recoveryConfidence: number;
  cacheLocality: number;   // 越靠后越高
}
```

按字典序或有界权重排序：

1. safety；
2. reclaimable + disposability；
3. recoveryConfidence；
4. cacheLocality。

禁止把 message index 直接乘以大权重，使其压过数量级更高的回收收益。

## 12.3 最小收益保护

如果早期候选比晚期候选多回收至少以下任一条件：

- 2,000 tokens；或
- 晚期候选回收量的 2 倍；

则选择早期候选。阈值必须可测试；在真实数据证明有必要前不增加配置项。

## 12.4 审计

prune action 增加可选字段：

```ts
{
  message_position: number,
  reclaimable_tokens: number,
  cache_locality: number,
  selected_rank: number
}
```

不得记录 provider cache 命中率，除非 Pi/provider 实际上报；禁止从位置推断并伪造命中率。

---

# 13. 分层可逆 folding

## 13.1 层级

```text
L0 原文：Pi session 中的原始工具结果
L1 extractive fold：head + error windows + tail（当前能力）
L2 semantic fold：结构化事实 + 关键结论 + recovery ref
L3 stub：最小事实 + recovery ref
```

所有层级都只是 effective context 表示；L0 不被改写。

## 13.2 状态转换

允许：

```text
L0 → L1
L0 → L3（明确 disposable/stale）
L1 → L2
L2 → L3
```

禁止：

```text
L1/L2/L3 → 生成式“恢复”L0
缺少 RecoveryRef 时进入 L2/L3
同一 context pass 重复折叠同一条目
```

每次转换必须以 L0 的 token 数和当前 replacement token 数执行 never-enlarge 检查。

## 13.3 L2 semantic fold

L2 是后续阶段，不属于首批实现。启用前必须满足：

- `context_search` 已上线且覆盖该工具类型；
- checkpoint LLM 预算与 semantic fold 预算分离；
- 有 per-session 上限、失败退避和 circuit breaker；
- 摘要 schema 固定并校验；
- 摘要必须声明不确定项，禁止补写原文不存在的结论；
- 缓存 key 至少包含 `contentHash + model + promptVersion`；
- 失败时保留 L1，不降级到 L3。

建议 schema：

```ts
interface SemanticFold {
  outcome: string;
  facts: string[];
  errors: string[];
  files: string[];
  commands: string[];
  omitted: string[];
  recovery: RecoveryRef;
}
```

## 13.4 召回层次

`context_search` 始终搜索 L0 原文，并可在 hit metadata 中附带当前 L1/L2/L3 表示。不得只搜索摘要，否则会把摘要遗漏永久放大。

---

# 14. 瞬态指导

## 14.1 注入点

使用 `before_agent_start` 返回当前 turn 的 `systemPrompt` 增量。不得通过永久 custom message 保存一般性指导。

## 14.2 内容

仅在满足触发条件时注入，最多约 120 tokens：

```text
Context engine: pressure 82%; 14K tokens reclaimable. Older tool outputs may be folded. Use context_search with a specific error code, path, or command fragment before re-running expensive work.
```

可包含：

- pressure band；
- reclaimable 大小级别；
- 当前是否存在 folded/stubbed 内容；
- 一条 `context_search` 使用建议；
- checkpoint/compact 即将触发的事实。

不得包含：

- pins 全文；
- checkpoint 全文；
- 用户约束；
- 搜索命中原文；
- 动态时间戳、随机 ID 或每轮变化的无关指标。

## 14.3 前缀稳定性

指导文本使用有限模板和离散 pressure band（例如 normal/high/critical），不要注入高精度百分比和不断变化的计数。相同 band 和状态下文本必须字节稳定，以减少 system prompt 抖动。

## 14.4 无 UI 模式

瞬态 system prompt 与 `ctx.hasUI` 无关；UI status 继续作为人类可见补充，不能替代模型指导。

---

# 15. 配置

首批新增字段：

```json
{
  "stub": {
    "enhanced": true,
    "maxChars": 360,
    "maxErrorChars": 180,
    "includeRecoveryRef": true
  },
  "search": {
    "enabled": true,
    "defaultLimit": 8,
    "maxLimit": 20,
    "maxSnippetChars": 800,
    "maxResultTokens": 3000,
    "defaultScope": "pruned"
  },
  "cacheAware": {
    "enabled": true
  },
  "transientGuidance": {
    "enabled": true,
    "minPressure": 0.65,
    "maxTokens": 120
  }
}
```

约束：

- 所有字段可选；
- 非法值回退默认并审计 `config_sanitized`；
- `maxChars` 不得超过 1,000；
- `maxResultTokens` 不得超过 8,000；
- `defaultLimit <= maxLimit`；
- search disabled 时不注册 `context_search`，命令返回明确禁用提示；
- 不为 semantic L2 提前加入无实现配置。

---

# 16. 审计与隐私

新增事件：

| 事件 | 数据 |
|---|---|
| `stub_enhanced` | tool、facts 字段名、长度、节省 token、recovery ID；不含 error 原文 |
| `context_search` | query hash、filters、扫描数、命中数、耗时、coverage |
| `context_search_sent` | 命中数、发送 token；不含正文 |
| `recovery_ref_unavailable` | item/tool/reason |
| `search_coverage_partial` | session/compaction 状态和原因 |
| `transient_guidance` | template ID、pressure band |

隐私要求：

- 审计日志不保存 raw query、snippet、完整 command、文件正文或错误原文；
- query 只记录 hash 和字符数；
- recovery ID 不包含 path、command 或用户内容；
- TUI 可以显示搜索结果，但不得因此写入 metrics/prune log；
- `--send` 后的结果按正常 Pi message 生命周期处理，用户显式选择视为允许进入有效上下文。

---

# 17. 性能预算

## 17.1 热路径

`context` event 新增成本：

- fact extraction 只对最终决定 stub 的条目执行；
- 单条最多扫描已有文本一次；
- error pattern 在模块加载时预编译；
- hash 与 token 估算复用单轮 memo；
- 不读 `prune-log.jsonl`；
- 不扫描 Pi branch；
- 不做 LLM、网络或额外同步文件写入。

保持整体 p95 < 20ms。

## 17.2 搜索慢路径

显式 search 目标：

| branch 原文规模 | p95 目标 |
|---|---|
| ≤ 5 MB | < 100ms |
| 5–25 MB | < 400ms |
| > 25 MB | 支持 AbortSignal，UI 显示扫描耗时 |

搜索不得阻塞 `context` event。只有真实性能数据证明需要时才增加内存索引。

## 17.3 Token 预算

- enhanced stub 必须比原文少至少 safety margin；
- `context_search` 工具结果默认 ≤ 3,000 tokens；
- transient guidance ≤ 120 tokens；
- 首批功能不产生额外 LLM 调用。

---

# 18. 错误处理

| 失败 | 行为 |
|---|---|
| fact extractor 抛错 | 回退通用 stub；仍做 never-enlarge |
| branch API 抛错 | 尝试 `buildContextEntries()`；标记 partial |
| prune log 损坏 | 搜索 scope 自动退化为 all；结果标记 prune metadata unavailable |
| search parser 非法 | 返回用户/工具参数错误，不扫描 |
| search 被 abort | 返回 cancelled，不审计为 error |
| transient prompt 构建失败 | 不注入，agent 正常运行 |
| recovery ref 冲突 | 不返回原文；显示 ambiguous，要求更具体查询 |
| renderer 失败 | 返回纯文本结果 |

任何错误都不得阻止 Pi 向模型发送未修改上下文。

---

# 19. 测试

## 19.1 Enhanced stub 单元测试

- Bash exit 0/1/null/cancelled；
- TypeScript、pytest、cargo、generic stderr 错误签名；
- ANSI/control character 清理；
- secret redaction；
- read path/range；
- grep/find 命中计数；
- 未识别工具退化；
- 长度预算逐级删字段；
- replacement 不节省 token 时保持原文；
- 相同输入输出字节一致。

## 19.2 RecoveryRef 测试

- branch entry ID 优先；
- toolCallId + hash fallback；
- compaction 后 message index 改变仍可定位；
- hash 冲突返回 ambiguous；
- session/branch 不匹配拒绝解析；
- details 向后兼容旧 stub。

## 19.3 Search 单元测试

- Latin token、quoted phrase、路径、错误码；
- 中文 unigram/bigram；
- tool/file filters；
- scope pruned/all；
- ranking 稳定；
- snippet 行号和窗口；
- secret redaction；
- token 总预算；
- 无结果和 partial coverage；
- AbortSignal。

## 19.4 Pi 事件级集成测试

使用 mock `ExtensionContext`：

- `registerTool("context_search")` 成功，模型调用能召回已 stub 的 L0；
- `/context search` 与工具返回相同 hit 顺序；
- 命令默认不触发 model turn；
- `--send` 只发送预算内摘要；
- branch 切换/compact 后缓存失效；
- `before_agent_start` 只在阈值以上返回稳定模板；
- search disabled 时工具不注册；
- 任一 search/fact extraction 异常不影响 context 发送。

## 19.5 前缀缓存排序测试

- 收益相近时选择较晚候选；
- 早期候选多回收 ≥2,000 tokens 时仍选早期；
- critical/pinned/active failure 不受位置影响；
- 相同输入排序稳定；
- 不伪造 cache hit 指标。

---

# 20. 验收场景

### Case R1 — 失败构建可继续

1. 生成包含 400+ 行输出和明确错误码的失败 build；
2. 触发 auto prune；
3. stub 必须保留 exit code 和首个错误签名；
4. 模型调用 `context_search` 搜索错误码；
5. 返回原始命中窗口，无需重新 build。

### Case R2 — superseded read 可召回

1. 连续读取并编辑同一文件，使早期 read stale；
2. 触发 prune；
3. `/context search file:<path> "<old symbol>"`；
4. 必须返回旧 read 的原文片段、行号和 recovery ID。

### Case R3 — 前缀缓存友好

1. 构造早、晚两个回收量相近的 disposable 输出；
2. 达到只需裁剪一个即可回落的压力；
3. 必须选择较晚条目；
4. 将早期条目增大 2,000 tokens 后，必须改选早期条目。

### Case R4 — compact 后召回

1. prune 一条工具结果；
2. 执行 Pi native compact；
3. 搜索该结果；
4. 若 Pi branch 仍暴露原文，必须召回并标记 pre-compaction；否则明确返回 partial coverage，不得伪造原文。

### Case R5 — 无持久原文副本

完成多轮 prune/search 后检查 engine session 目录：只允许 state、pins、metrics、prune metadata 和 checkpoints；不得出现 search index、raw output cache 或完整 snippet 日志。

### Case R6 — 瞬态指导不污染历史

连续 10 轮处于同一 high pressure band：每轮 system prompt 增量字节一致，Pi session branch 不新增对应永久 message。

---

# 21. 成功指标

| 指标 | 目标 |
|---|---|
| enhanced stub 保留结构化 outcome 的比例 | ≥ 95%（支持的工具类型） |
| stub 额外 LLM 调用 | 0 |
| 搜索命中后避免重复执行昂贵命令的比例 | 可观测后建立基线，不预设伪精度目标 |
| 已记录 prune item 的可解析 RecoveryRef 比例 | ≥ 99% |
| `/context search` ≤5 MB branch p95 | < 100ms |
| context 热路径 p95 | < 20ms |
| 工具搜索结果默认 token | ≤ 3,000 |
| 永久原文副本 | 0 |
| search/fold 导致 agent 中断 | 0 |

provider 未上报 cache usage 时，不设置“缓存命中率提升”指标。只记录可验证代理指标：被改写的最早 message position 和选择排序。

---

# 22. 实施阶段

```text
P0 — Recovery 基础
  RecoveryRef、branch source adapter、SearchDocument、旧 details 兼容

P1 — 低成本高收益
  enhanced stub、长度预算、脱敏、审计、/context search 词法版

P2 — 模型自助召回
  Pi registerTool(context_search)、共享 renderer、token 总预算、AbortSignal

P3 — 缓存与指导
  prefix-aware candidate ordering、before_agent_start 瞬态指导

P4 — 分层 folding
  L1/L3 状态统一；满足召回和预算前置条件后再实现 L2 semantic fold
```

阶段约束：

- P0/P1 必须一起发布，禁止只有 recovery ID 而没有可用搜索；
- P2 完成前不得宣称“模型可以自助召回”；
- P3 不得改变现有安全分类结果；
- P4 的 L2 必须单独写实现细化和模型成本验收；
- 每阶段运行相关 unit/integration tests、`tsc --noEmit` 和真实 Pi smoke test。

---

# 23. 文档变更

实现后同步：

- `README.md` / `README.zh-CN.md` Commands 表；
- What gets pruned 中的 enhanced stub 格式；
- Safety model 中的 session-native recovery；
- 配置示例；
- Roadmap：词法 recall 完成状态、semantic folding 前置条件；
- `/context history` 的 search/recovery 审计说明。

不得把通用代理、跨宿主支持或 proxy/plugin 架构加入 roadmap，除非后续产品决策显式改变当前范围。

---

# 24. 最终不变量

> 1. Pi session 原文是唯一事实源；effective context 可以缩短，session 不被改写。  
> 2. stub 的每个事实都可从原结构或文本确定提取。  
> 3. 模型通过 Pi 原生工具召回，不通过代理。  
> 4. 搜索默认按需、当前 branch、只读、不持久化原文。  
> 5. 前缀缓存只优化候选顺序，不凌驾于正确性和回收收益。  
> 6. semantic fold 上线前必须已经能检索 L0。  
> 7. 指导可以瞬态，约束和任务事实必须持久。  
> 8. 任一引擎失败都不得阻止 Pi 使用原始上下文继续运行。
