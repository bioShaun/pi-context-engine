# pi-context-engine — 自动模式优化 Spec（v0.2 目标）

> 前置文档：`pi-context-engine.spec.md`（v0.1）。本文档只定义**自动（无人值守）路径**的优化，
> 手动命令（`/context clean|checkpoint|compact|handoff`）的语义不变。

---

# 1. 背景与设计原则

v0.1 已实现完整的手动命令集和基础自动策略。但真实使用中：

> **绝大多数用户永远不会手动执行 `/context *` 命令。**

因此 v0.2 的核心原则：

### P1 — Auto-first

自动路径是唯一必须正确的路径。手动命令只是自动路径失效时的逃生舱，
不为手动路径做任何自动路径不需要的特化。

### P2 — 单一计量口径（Single meter）

pressure、quality、reclaimable、"never enlarge" 比较、post-prune 重估，
必须使用**同一个 token 计量器**。两套尺子比大小是自动误判的根源。

### P3 — 成本守恒

自动路径自身消耗的 LLM 调用（checkpoint）必须有预算、有退避、可熔断。
引擎绝不能成为新的 token 消耗源。

### P4 — 防震荡（Hysteresis）

所有自动动作使用「进入阈值 > 退出阈值」的双阈值 + cooldown，
禁止 prune/compact 在边界上反复振荡。

### P5 — 继承 v0.1 安全模型

fail-open（§36）、non-destructive（§33）、idempotent（§34）、
audited（§29）、never-enlarge（§51）全部保留，且按 P2 修正其实现。

---

# 2. 现状缺陷（自动路径专属）

以下问题均只影响或主要影响自动路径，按严重度排序：

### D1 — compactionCount 双计数【bug，P0】

`src/index.ts` auto compact 的 `onComplete` 与 `session_compact` 处理器
对同一次 compaction 各 `+1`。后果：handoff 门槛（≥2 次 compaction）
在一次 auto compact 后即被满足，handoff 建议过早出现。

**修复**：`session_compact` handler 是唯一计数源；删除 auto `onComplete`
中的计数。补事件级集成测试（§12）。

### D2 — pin 匹配大小写不一致【bug，P0】

- `classifier.ts applyPins`：text pin 被 `normalizePathLike` 转小写后与
  原始大小写的消息文本 `includes` 比较 → 含大写字母的 pin 永不命中，
  无法把对应条目标记为 critical。
- `pins.ts ensurePinsInContext`：file pin 的存在性检查用
  `p.content.toLowerCase()` 对比原始大小写 corpus → 含大写字母的 file pin
  在**每次** context 事件重复注入一条 pins 消息，context 单调膨胀。

**修复**：匹配两侧统一规范化（比较时对 corpus 做一次性 lowercase，
缓存结果）；text pin 不使用路径规范化函数。

### D3 — checkpoint 失败无退避【P0】

checkpoint 生成失败（模型输出非法 JSON / 超时 / abort）后，
下一个 context 事件立即重试。高压期间（正是 checkpoint 最常被触发的时刻）
形成每轮一次失败 LLM 调用的烧钱循环。

### D4 — checkpoint 新鲜度按墙钟判定【P1】

`checkpointFreshMs = 10min`。一个 9 分钟前生成、此后又执行了 50 次
工具调用的 checkpoint 仍判定为 fresh，导致该 checkpoint 时不再 checkpoint，
compact 锚定的是过时状态。

### D5 — 计量口径混用【P1】

- `item.estimatedTokens` 可能来自 Pi 的 `estimateTokens`（精确），
  而 pruner 的 never-enlarge 比较和 post-prune 压力重算用字符估算（粗糙）。
- post-prune pressure = `(usage.tokens − removedTokens估算值) / usable`，
  分子分母三个来源。

### D6 — 关键阈值硬编码【P1】

`reclaimableTokens > 5_000`（policy/engine.ts）不可配置，
与 README「所有自动行为可配置」的承诺不符。

### D7 — read 取代忽略读取范围【P2】

`read A (1-100)` 与 `read A (500-600)` 是互补读取，当前 group key 只含
path，后者将前者标 stale → stub，丢失前半段内容。

### D8 — checkpoint 序列化丢头部【P2】

`serializeConversation` 超长时 `slice(-maxTotal)` 只保留尾部，
而 task goal 与早期用户约束恰在头部 → checkpoint 丢失最关键信息。

---

# 3. 自动处理流水线（重构）

每个 `context` 事件执行一个**确定性五阶段状态机**，全部同步代码
（LLM 调用仅 checkpoint，且 fire-and-forget）：

```text
OBSERVE → DECIDE → PRUNE → REINJECT → ESCALATE
```

```ts
async function onContext(event, ctx) {
  // OBSERVE：统一计量（§4），单轮 memoize（§10）
  const m = measure(event.messages, ctx)          // 唯一 token 来源
  const analysis = analyze(event.messages, m)

  // DECIDE：纯函数状态机，输出动作集合（§5）
  const plan = decide(analysis, state, config)     // 含 hysteresis（§6）

  // PRUNE：非破坏重写（同 v0.1），never-enlarge 用 m 复核
  let messages = event.messages
  if (plan.prune) {
    const r = prune(messages, analysis, m)
    messages = r.context
    analysis = m.recompute(analysis, r)            // 同口径重估
  }

  // REINJECT：pins 保活（修复 D2 后）
  messages = ensurePins(messages, pins)

  // ESCALATE：事件内升级链（同 v0.1 §42 语义）
  if (plan.checkpoint) fireAndForgetCheckpoint()   // 含退避（§7）
  if (plan.compact || postPrunePressureCrossed())  requestCompact()
  if (plan.handoffSuggest)                         suggestHandoff()  // 仍只建议

  return messages !== event.messages ? { messages } : undefined
}
```

与 v0.1 的差异：
1. `measure` 是唯一 token 计量入口（P2）；
2. `decide` 一次性输出全部动作，不再有分散在各处的二次判断；
3. post-prune 重估走 `m.recompute`，不再手工减估算值（修复 D5）。

---

# 4. 统一计量层（Measure）

### 4.1 接口

```ts
interface Meter {
  tokens(msg: AnyMessage): number            // 单消息，带缓存
  total(messages: readonly AnyMessage[]): number
  recompute(a: ContextAnalysis, r: PruneResult): ContextAnalysis
  calibrate(reported: number): void          // 见 4.3
}
```

### 4.2 估算器选择顺序

1. `ctx.getContextUsage().tokens`（Pi 上报，含 system prompt）→ 作为
   **total** 的唯一权威值；
2. 单消息粒度用 Pi `estimateTokens`；
3. 均不可用时回退字符启发式。

pressure 计算：`usage.tokens` 为分子时，分母必须是同一窗口口径
（`window − outputReserve − safetyReserve`），禁止与字符估算混合运算。

### 4.3 校准（calibration）

每次 `usage.tokens` 可用时，记录
`ratio = usage.tokens / estimatedTotal` 的滑动平均（窗口 20 轮），
后续无 usage 的轮次用 `estimatedTotal × ratio` 修正。
使无 usage 期间的 pressure 估计与实际趋势一致。

### 4.4 CJK 感知字符估算

字符启发式按脚本分段：

```ts
tokens ≈ ceil(asciiChars / 4 + cjkChars / 1.5)
```

中文场景当前低估 2–3 倍，导致自动动作系统性滞后，必须修复。

---

# 5. 决策机（Decide）

### 5.1 输出

```ts
interface AutoPlan {
  prune: boolean
  pruneOpts: PruneOptions        // 由 pressure 分档（§8.1）
  checkpoint: boolean
  compact: boolean
  handoffSuggest: boolean
  reason: string                 // 进审计日志
}
```

### 5.2 决策规则（优先级从高到低）

```text
1. pressure < green 且 quality > 0.6            → 全否（fast path）
2. 有可回收量 ≥ reclaimableMin 且 pressure ≥ prune.enter   → prune
3. pressure ≥ checkpoint.enter 且 checkpoint 不新鲜（§7.1）→ checkpoint
4. compact 边际收益衰减（§9.2）且 pressure ≥ handoff.enter → handoffSuggest
5. pressure ≥ compact.enter                      → compact（前置 fresh checkpoint）
```

`reclaimableMin` 进入配置（修复 D6），默认 5000，可按模型覆盖。

---

# 6. 防震荡（Hysteresis + Cooldown）

每个自动动作定义 enter/exit 双阈值：

| 动作 | enter | exit（连续两轮低于此值才重置状态） |
|---|---|---|
| prune | 0.65 | 0.55 |
| checkpoint | 0.80 | 0.70 |
| compact | 0.88 | 0.78 |

另加：

- **cooldown**：prune 15s / compact 300s（同 v0.1）；
- **每动作每 10 轮最多触发 3 次**（滑动窗口计数），超限则降级为
  notify 并写审计事件 `policy_throttled`；
- 动作生效的判断：prune 后 `pressureAfter < enter − 0.05`，否则记一次
  「无效 prune」，连续 2 次无效 prune 自动提高该动作的 enter 阈值 0.05
  （自适应，§9.1）。

---

# 7. Checkpoint 自动化治理

### 7.1 新鲜度重定义（修复 D4）

checkpoint 新鲜 ⇔ **同时满足**：

```text
wallClockAge < checkpointFreshMs                    （10 min，同 v0.1）
AND tokensSinceCheckpoint < checkpointStaleTokens   （新增，默认 20K）
AND messagesSinceCheckpoint < 30                    （新增）
```

`tokensSinceCheckpoint` 由计量层增量累计（§4）。任一超限即 stale。

### 7.2 失败退避与熔断（修复 D3）

```text
失败后重试间隔：30s → 60s → 120s → … 上限 10min（指数退避）
连续失败 3 次 → 熔断至 session 结束，降级为：
  - notify 一次「auto checkpoint disabled: <原因>」
  - compact 仍可触发，但 customInstructions 退化为 v0.1 的通用指令
```

退避状态进 `state.json`（`lastCheckpointAttemptAt`、`checkpointFailStreak`），
重启会话后保留。

### 7.3 序列化保留头部（修复 D8）

超长时不做纯尾部截断，改为：

```text
[首条 user 消息（goal 出处，原文保留，上限 2K 字符）]
+ [所有 active pins]
+ [尾部窗口（maxTotal − 头部开销）]
```

### 7.4 成本治理（P3）

- 新增配置 `checkpointModel`（默认 `null` = 跟随会话模型）；
  允许指定廉价模型做 checkpoint 生成；
- 每 session checkpoint LLM 调用预算：`maxCheckpointsPerSession`
  （默认 20），超限熔断，仅 notify；
- 所有 checkpoint 调用写审计事件（含 token 消耗，若 registry 返回）。

---

# 8. Prune 自动化增强

### 8.1 力度随压力分档（替代固定 AUTO/MANUAL 两套参数）

| pressure 区间 | stubMinTokens | foldMaxChars | 说明 |
|---|---|---|---|
| [0.65, 0.80) | 50 | 2200 | 保守（现 AUTO） |
| [0.80, 0.88) | 30 | 1600 | 中等（现 MANUAL） |
| ≥ 0.88 | 20 | 1200 | 激进 |

手动 `/context clean` 固定使用「激进」档。分档参数全部可配置。

### 8.2 read 取代带范围（修复 D7）

read group key 纳入 `(offset, limit)` 归一化区间：

```text
两次 read 的区间相交或包含 → 后者 supersede 前者
区间不相交                  → 各自保留（互补读取）
无 offset/limit 的全文 read → supersede 该文件此前全部 read
```

### 8.3 折叠质量

`foldBashOutput` 的 error 行提取，从「匹配行本身」扩展为
「匹配行 ±2 行上下文窗口」，窗口总数仍受 `maxErrorLines` 约束。
对 pytest/编译错误这类「错误行 + 上下文才有意义」的输出显著改善可用性。

---

# 9. Compact 与 Handoff 自动化

### 9.1 Compact 后效验证

每次 compact 完成后的下一个 context 事件，记录
`pressureDrop = pressureBefore − pressureAfter`：

- `pressureDrop < 0.05` → 记一次「低效 compact」（审计事件
  `compact_ineffective`）；
- 连续 2 次低效 compact → 该 session 的 compact enter 阈值自动 +0.04
  （noise 太多，compact 收益低，把预算留给 handoff 建议）。

### 9.2 Handoff 建议时机（替代固定 compactionCount ≥ 2）

触发条件改为（仍**只建议**，不自动执行）：

```text
pressure ≥ handoff.enter（默认 0.94）
AND checkpoint 新鲜（§7.1，保证可恢复）
AND (
  compactionCount ≥ 2 且 quality < 0.5        （原条件）
  OR 最近一次 compact 低效（§9.1）             （新增：边际收益衰减信号）
)
```

修复 D1 后 `compactionCount` 语义才正确；本节依赖该修复。

### 9.3 Compact 指令增强

`compactInstructions` 追加：

- 上次 compact 低效时，附加「上一轮 compact 未有效降低压力，
  本次摘要应更激进地丢弃工具输出细节」；
- pins 中的 constraint/requirement 全文（当前仅 checkpoint 字段）。

---

# 10. 热路径性能预算

目标不变：**每轮 `context` 事件处理 < 20ms**（不含 checkpoint LLM 调用）。

必须做的：

1. **pins 内存缓存**：`PinStore` 启动时读一次 `pins.json`，之后内存操作，
   变更才落盘。消除每轮 `readFileSync + JSON.parse`。
2. **单轮 memoize**：同一 `context` 事件内，`messageText(msg)` 与
   `tokens(msg)` 按 message index 缓存（当前每条消息重复计算 2–3 次）。
3. **审计异步批量落盘**：`appendJsonl` 改为内存 buffer +
   每 5s / 每 50 条 / session_shutdown 时 flush（`fs.appendFile`，
   失败丢弃不阻塞）。
4. **glob 预编译**：`config.models` 的 pattern 在 `loadConfig` 时编译为
   RegExp 缓存，`resolveThresholds` 不再重复编译；
   同时按特异性排序（精确匹配 > 长前缀 > `*`），修复多 pattern 命中时
   顺序依赖问题。

---

# 11. 配置变更（v0.2 schema）

新增/修改字段（全部可选，缺省即下列默认值；加载时做**类型校验**，
非法值回退默认并写审计事件 `config_sanitized`）：

```json
{
  "thresholds": {
    "prune":      { "enter": 0.65, "exit": 0.55 },
    "checkpoint": { "enter": 0.80, "exit": 0.70 },
    "compact":    { "enter": 0.88, "exit": 0.78 },
    "handoff":    { "enter": 0.94 }
  },
  "policy": {
    "reclaimableMin": 5000,
    "maxActionsPer10Turns": 3,
    "adaptiveThresholds": true
  },
  "checkpoint": {
    "freshMs": 600000,
    "staleTokens": 20000,
    "staleMessages": 30,
    "model": null,
    "maxPerSession": 20,
    "backoffMs": [30000, 60000, 120000],
    "maxFailStreak": 3
  },
  "prune": {
    "bands": [
      { "pressureGte": 0.88, "stubMinTokens": 20, "foldMaxChars": 1200 },
      { "pressureGte": 0.80, "stubMinTokens": 30, "foldMaxChars": 1600 },
      { "pressureGte": 0.0,  "stubMinTokens": 50, "foldMaxChars": 2200 }
    ]
  }
}
```

兼容性：v0.1 的扁平 `thresholds: { prune: 0.65, ... }` 配置加载时
自动迁移为 enter/exit 形式（exit = enter − 0.10），并写一次
`config_migrated` 审计事件。

---

# 12. 测试与验收

### 12.1 新增事件级集成测试（mock ExtensionContext）

- **T1**：触发一次 auto compact → 断言 `compactionCount === 1`（防 D1 回归）；
- **T2**：pin `"Don't modify X"` → 断言包含该文本的条目标记 critical；
  file pin 含大写路径 → 连续两个 context 事件只注入一次 pins 消息（防 D2 回归）；
- **T3**：mock checkpoint 连续失败 → 断言退避间隔生效、第 3 次后熔断且
  无新 LLM 调用（防 D3 回归）；
- **T4**：构造 checkpoint 后注入 25K tokens 新消息（墙钟 < 10min）→
  断言判定为 stale（防 D4 回归）；
- **T5**：互补区间的两次 read → 断言均不被 stub（防 D7 回归）。

### 12.2 自动场景验收（Auto-only，全程禁止手动命令）

- **Case F — 长会话自动化**：脚本化构造 200+ 工具调用的会话
  （install/build/test 循环 + 大文件读取），全程不输入任何 `/context`
  命令。验收：pressure 峰值 ≤ 0.95；session 未被 provider 截断；
  引擎自身 LLM 调用 ≤ `maxPerSession`。
- **Case G — 中文会话**：以中文需求为主的会话。验收：pressure 曲线与
  Pi 实际上报 usage 偏差 < 15%（校准生效，§4.3/§4.4）。
- **Case H — 震荡场景**：构造 pressure 在 0.86–0.90 间来回的会话。
  验收：compact 触发次数 ≤ 2 次 / 20 轮，且有 `policy_throttled`
  审计事件（hysteresis 生效）。

### 12.3 成功指标（自动路径）

| 指标 | 目标 |
|---|---|
| 无需手动干预完成任务的会话占比 | ≥ 90% |
| auto prune 后 pressure 回落 ≥ 0.05 的比例 | ≥ 80% |
| checkpoint 一次成功率（schema 校验通过） | ≥ 95% |
| 引擎自身 token 消耗占会话总消耗 | < 3% |
| 热路径 p95 耗时 | < 20ms |

---

# 13. 实施阶段

```text
P0（正确性）：D1 双计数、D2 pin 大小写、D3 退避熔断、§12.1 T1–T3
P1（计量与策略）：§4 统一计量 + CJK + 校准、D4/D5/D6、§6 hysteresis、T4
P2（质量与自适应）：D7/D8、§8 分档与折叠、§9 compact 后效/handoff 时机、T5
P3（性能与收尾）：§10 热路径、§11 配置迁移、§12.2 验收场景
```

每阶段结束跑 `node --test tests/` + `tsc --noEmit` + live smoke test
（`pi -e ./src/index.ts` 构造合成会话验证）。

---

# 14. 设计原则（本节不变，重申）

> 1. 自动路径是唯一必须正确的路径（P1）。
> 2. 一把尺子量到底（P2）。
> 3. 引擎不能成为新的 token 消耗源（P3）。
> 4. 宁可少做，不可做错 —— precision > recall（继承 §51）。
> 5. Never silently destroy context（继承 §29）。
