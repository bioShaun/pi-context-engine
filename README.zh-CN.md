# pi-context-engine

面向 [Pi Coding Agent](https://github.com/badlogic/pi-mono) 的上下文生命周期引擎。
这是一个 Pi 扩展（extension），负责管理真正发送给模型的*有效上下文*：

- **度量**上下文压力与质量（`/context`）
- **无损裁剪**低价值工具输出（`/context clean`，以及自动执行）
- 将任务状态固化为**结构化 checkpoint**（固定 JSON schema，`/context checkpoint`）
- 用 checkpoint 锚定指令**驱动 Pi 原生 compaction**（`/context compact`）
- 生成自包含 handoff 提示词，**交接**给全新会话（`/context handoff`）
- **pin（钉住）**关键约束，使其在任何破坏性操作后依然存在

[English documentation](README.md) · [设计规格（zh）](docs/pi-context-engine.spec.md)

```
pi 原生会话（从不修改）  ──►  context 事件  ──►  有效上下文
                                              （已裁剪、已折叠、
                                               pins 重新注入）
```

> 保留工作集，驱逐噪音，保持可恢复。

## 安装

```bash
# 从 GitHub 安装（全局安装 → ~/.pi/agent/settings.json）
pi install git:github.com/bioShaun/pi-context-engine

# 项目级安装（→ .pi/settings.json，可与团队共享）
pi install -l git:github.com/bioShaun/pi-context-engine

# 不安装，仅在当前运行中临时试用
pi -e git:github.com/bioShaun/pi-context-engine
```

- 也支持 SSH 源：`pi install git:git@github.com:bioShaun/pi-context-engine`
  （使用已配置的 SSH key / `~/.ssh/config`）。
- 本地开发：`pi install /绝对路径/pi-context-engine` 或 `pi -e ./src/index.ts`。

git 安装会自动 clone 仓库并执行 `npm install`（Pi 核心包声明为
peer 依赖，由 Pi 本身提供——扩展没有自己的运行时依赖）。

卸载：`pi remove git:github.com/bioShaun/pi-context-engine`。
`pi list` 查看已安装包；`pi update --extensions` 更新它们。

状态按会话本地存储（绝不触碰你的仓库）：

```
~/.pi/context-engine/
├── config.json                  # 可选的全局配置
└── sessions/<session-id>/
    ├── state.json               # compaction/checkpoint/handoff 计数
    ├── pins.json
    ├── metrics.jsonl            # 每轮指标 + 动作事件
    ├── prune-log.jsonl          # 每个被裁剪条目一行（审计）
    └── checkpoints/
        ├── cp-0001.json
        └── latest.json
```

项目级覆盖：`.pi/context-engine.json`（同一 schema，深度合并）。
环境变量覆盖（测试/CI）：`PI_CONTEXT_ENGINE_CONFIG=/path/to/config.json`。

## 命令

| 命令 | 作用 |
|---|---|
| `/context` | 压力、质量、分类占比、最大占用项、建议动作 |
| `/context clean` | 手动激进清理：stale/重复项打桩（stub），超大输出折叠。下一次模型调用时生效；会话文件不动 |
| `/context checkpoint` | LLM 生成、schema 校验的任务 checkpoint（`cp-NNNN.json`） |
| `/context compact` | 用 checkpoint 锚定指令触发 Pi 原生 compaction |
| `/context handoff` | checkpoint → 自包含 handoff 提示词 → 新会话（切换前可编辑） |
| `/context pin <text>` | 钉住约束/需求/文件/命令/备注（自动推断类型） |
| `/context pin-last` | 钉住最近一条用户消息 |
| `/context pin-file <path>` | 钉住文件（其读取结果永不被裁剪） |
| `/context pins` / `/context unpin [id]` | 列出 / 移除 pins |
| `/context history` | 近期裁剪、checkpoint、compaction 的审计记录 |

## 自动策略

每次模型调用前，observer 都会估算压力与质量：

```
pressure  = 上下文 tokens / (窗口 − 输出预留 − 安全预留)
quality   = (critical + working tokens) / 总 tokens
```

| 条件（默认值） | 动作 |
|---|---|
| pressure < 55% 且 quality > 60% | 无动作（快速路径） |
| pressure ≥ 65% 且可回收 > 5K | **自动 prune**（无损折叠/打桩） |
| pressure ≥ 80% 且无新鲜 checkpoint | **自动 checkpoint**（后台 LLM 调用） |
| pressure ≥ 88% | **自动 compact**（checkpoint 锚定） |
| pressure ≥ 94% 且 compact ≥ 2 次 且 quality < 50% | **建议 handoff**（永不自动执行） |

模型专属阈值通过配置覆盖（例如小参数本地模型更早触发 prune/compact）。
所有自动行为均可单独开关，且全部留有审计记录。

```json
{
  "enabled": true,
  "auto": { "prune": true, "checkpoint": true, "compact": true },
  "handoff": { "mode": "suggest" },
  "thresholds": { "prune": 0.65, "checkpoint": 0.80, "compact": 0.88, "handoff": 0.94 },
  "models": { "qwen*": { "prune": 0.55, "compact": 0.78 } }
}
```

## 什么会被裁剪

分类基于规则（不对每条消息调用 LLM）：

- **critical（关键）** — 用户消息、摘要、被 pin 的内容 → 永不触碰
- **working（工作集）** — 最近读取、活动中的失败、近期工具输出 → 只做*折叠*
  （头部 + 错误 + 尾部），绝不丢弃
- **stale（过期）** — 被后续版本取代的读取（`read A → edit A → read A`）、
  更早的相同命令、旧的失败测试、旧搜索重复 → 打桩
- **disposable（可弃）** — 安装/下载/构建噪音、琐碎命令、通过的测试列表、
  目录列举 → 打桩

桩（stub）是一行标记（`[pi-context-engine] bash result pruned …`），
**只在有效上下文中**替换大段输出。原始数据仍保留在会话文件里——
重跑命令或恢复会话都能找回。裁剪是幂等的（已打桩的结果不会被二次折叠），
且工具结果只被原地替换、从不删除，因此 provider 的 tool-call 配对关系始终成立。

## 安全模型

- **Fail-open（失败放行）**：引擎任何错误都会记入 `metrics.jsonl` 并被吞掉，
  Pi 用未修改的上下文继续运行。
- **绝不增大**：若替换后的内容比原文更费 token，则跳过该条。
- **Pins 永生**：pin 内容一旦从有效上下文中消失，就会以隐藏消息重新注入；
  被 pin 的文件其读取结果强制视为 critical。
- **Handoff 默认只建议**（`handoff.mode: "suggest"`）；
  显式 `/context handoff` 命令是唯一的 handoff 路径。
- **全程审计**：每次打桩/折叠都在 `prune-log.jsonl` 中记一行 JSON，
  含原文/替换后大小与原因。

## 开发

```bash
npm install
npm test          # node --test（Node >= 23.6，原生 TS）
npm run typecheck
```

目录结构遵循 spec 推荐的源码布局（`src/observer`、`src/classifier`、
`src/pruning`、`src/checkpoint`、`src/policy`、`src/pins`、`src/handoff`，
以及 `src/index.ts` 中的 commands 式分发）。

## 路线图（spec §47–49）

- v0.2：checkpoint 自动刷新、Pi compaction hook 集成、更好的测试结果折叠、
  git 感知的 diff 跟踪、任务阶段检测
- v0.3：handoff 评分、新会话自动引导、checkpoint 恢复
- v0.4：语义折叠（embedding / 按需召回）
