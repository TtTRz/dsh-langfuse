# dsh-langfuse

> [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Langfuse LLM 可观测插件——每个 agent 会话一棵 OpenTelemetry trace 树，附反馈打分与子 agent 血缘。

[![npm version](https://img.shields.io/npm/v/dsh-langfuse)](https://www.npmjs.com/package/dsh-langfuse)
[![license](https://img.shields.io/npm/l/dsh-langfuse)](LICENSE)
[![node](https://img.shields.io/node/v/dsh-langfuse)](https://nodejs.org)

把每个 agent 会话以 OpenTelemetry trace 树上报到 [Langfuse](https://langfuse.com)：**turn → trace**、**模型 step → generation**、**工具调用 → tool span**，带 GenAI 语义约定属性、token 用量、首 token 时间与错误状态。

## ✨ 特性

- 🧵 **全链路追踪**——每轮 turn、每次 generation、每个工具调用都进 Langfuse，含模型/供应商/用量（含缓存与推理 token）/TTFT
- 🚚 **Content-Length 传输**——报文单次写入并显式带 `Content-Length`，绝不发 chunked。部分 Langfuse 部署的前置网关会破坏 chunked 的 POST 体（`400 Failed to parse OTel JSON Trace`），本传输从根上绕开这类问题
- 👍 **反馈打分**——`/feedback` 记录变成挂在最近一轮 turn trace 上的 TEXT score
- 🔗 **子 agent 血缘**——子会话的 turn trace 链接到父会话的 trace（同进程）
- 🎚️ **三种上报模式**——`FULL`（实时）/ `FEEDBACK_ONLY`（用户记录反馈时才上报）/ `DISABLED`（默认，不出网）
- 🔒 **可选 input**——generation input（system prompt / 工具 / prompt）仅在 `includeGenerationInput` 开启时导出
- 🛡️ **配置失败即报错**——非法 URL、缺密钥、非法数值在插件加载时即抛出

## 🚀 快速开始

```sh
dsh plugin --profile web add dsh-langfuse

export LANGFUSE_PUBLIC_KEY=pk-lf-...
export LANGFUSE_SECRET_KEY=sk-lf-...
# 可选：自建实例或非 EU region
export LANGFUSE_HOST=https://langfuse.example.com

dsh web   # 重启实例，聊一轮即可在 Langfuse 看到 trace
```

有 key 即 `FULL` 实时上报；无 key 则 `DISABLED`。`LANGFUSE_TELEMETRY_MODE=FEEDBACK_ONLY` 收敛为反馈门控，`LANGFUSE_INCLUDE_GENERATION_INPUT=1` 导出 generation input。

自带 patch 会禁用 dsh-base 的 `session-telemetry-otel` 行（seam 每个 context 只接受一个后端）并挂载本包；`dsh --profile web --dump-config` 可不启动直接查看组合结果。

### 显式 `cordis.yml` 行

```yaml
- id: session-telemetry-langfuse
  name: dsh-langfuse
  config:
    mode: FULL                 # FULL | FEEDBACK_ONLY | DISABLED（默认）
    exporter:
      url: https://cloud.langfuse.com/api/public/otel/v1/traces
    auth:
      publicKey: !!js process.env.LANGFUSE_PUBLIC_KEY
      secretKey: !!js process.env.LANGFUSE_SECRET_KEY
    processor: {}              # 可选；原样透传给 BatchSpanProcessor
    includeGenerationInput: false
```

## ⚙️ 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `mode` | `DISABLED` | `FULL` 实时导出；`FEEDBACK_ONLY` 记录反馈时才回放导出；`DISABLED` 什么都不构造 |
| `exporter.url` | — | 完整 OTLP traces 端点（`…/api/public/otel/v1/traces`），非 `DISABLED` 必填 |
| `exporter.timeoutMillis` | `10000` | 单请求超时 |
| `auth.publicKey` / `auth.secretKey` | — | Langfuse 项目密钥对（Basic auth），非 `DISABLED` 必填 |
| `processor` | `{}` | 原样透传给 `BatchSpanProcessor`；重试（有限退避，6 次）在 exporter 内 |
| `includeGenerationInput` | `false` | 导出 `langfuse.observation.input`（system prompt / 工具 schema / 模型 / 用户 prompt） |
| `maxAttributeChars` | `16384` | 单属性载荷上限，超长截断并打 `…[truncated]` 标记（canonical log 保留全量） |
| `shutdownTimeoutMillis` | `3000` | SDK 关停排空的截止时间 |
| `feedbackScoreName` | `user-feedback` | `/feedback` 推送的 score 名 |

## 🧭 Langfuse 里的呈现

| dsh 会话事件 | Langfuse 概念 |
|---|---|
| `turn/start` / `turn/end` | trace（`turn N`；错误结束 → ERROR 状态） |
| `step/start` + `request/header` + `assistant/message` | **generation**（`step T.S`）——模型/供应商/输出/`gen_ai.usage.*` |
| 每步第一个 `assistant/chunk` | `langfuse.observation.completion_start_time`（TTFT） |
| `tool/call` + `tool/result` | tool span（入参→input，结果→output，`isError`→ERROR） |
| `user/message` | trace input |
| `feedback/record` | TEXT score，挂在最近一轮 turn trace |
| 子会话 turn | trace 链接到父会话 trace |
| `agent-error` ops 记录 | 异常事件 + ERROR 状态 |
| 其余事件（todo、plan、compaction…） | 开放 turn 上的时间点 span event |

关联属性用本包自有词汇（`dsh.turn_idx`、`dsh.step_idx`、`dsh.event_seq`…），多个遥测后端可共用一个 Langfuse 项目而不冲突。

## 🏗️ 工作原理

- **遥测 seam 后端**：harness 把一切模型可见内容记入 canonical session log；本插件实现 `SessionTelemetryBackend`（`@deepseek-ai/dsh-session-telemetry`），天然覆盖全部事件（含没见过的类型），并免费获得 seam 的同意语义与脱敏 waterfall
- **OTel SDK + 自定义 exporter**：`BasicTracerProvider` + `BatchSpanProcessor` 造 span，`@opentelemetry/otlp-transformer` 序列化，自定义 `SpanExporter` 以 `Content-Length` + 有限重试投递
- **折叠时间线**：`SessionTimeline` 把平铺记录流按 `(session.id, turn, step)` 折成 span 树；边界时间一律取记录自身时间戳——实时捕获与 canonical log 回放产出完全一致的树
- **at-most-once 交付**（继承自 seam）：丢失窗口=崩溃窗口；接收方用 `langfuse.session.id` + `dsh.turn_idx` + `dsh.event_seq` 关联

## 🧪 开发

```sh
npm run check   # biome + typecheck + vitest（单测 & seam 集成）+ 构建
```

30 个测试覆盖配置校验、折叠时间线、传输（`Content-Length` 存在、无 `Transfer-Encoding`、重试/退避）、score 推送，以及驱动真实 `SessionTelemetryCoordinator` 的全链路 seam 集成。

## ⚠️ 限制

- 每个 context 只接受一个后端（自带 patch 已禁用官方 OTLP-logs 行）
- 子 agent 血缘仅同进程尽力而为（跨进程重启后父 trace id 未知）
- 无持久化投递（at-most-once）
- score 推送 fire-and-forget（失败只告警）

## 📄 License

[MIT](LICENSE)
