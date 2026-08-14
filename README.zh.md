# dsh-langfuse

DeepSeek Harness 的 Langfuse 可观测插件：把每个 agent 会话导出为 OpenTelemetry trace 树（turn→trace、step→generation、tool→span，GenAI 语义约定 + `langfuse.*` 属性）发送到 Langfuse 的 OTLP 端点（`/api/public/otel/v1/traces`，只收 traces——这正是官方 OTLP-logs 后端喂不了 Langfuse 的原因）。

基于官方遥测 seam（`@deepseek-ai/dsh-session-telemetry`），四个刻意设计：

1. **Content-Length 传输**：报文单次写入并显式携带 `Content-Length`，绝不发 `Transfer-Encoding: chunked`。部分 Langfuse 部署的前置网关会破坏 chunked 的 POST 体，导致 `400 Failed to parse OTel JSON Trace`（实测：chunked 100% 400、Content-Length 100% 200），而 OTel SDK 自带 exporter 永远发 chunked 且无开关。用本包则两端都不需要 node_modules 补丁。
2. **反馈打分**：`feedback/record`（dsh 的 `/feedback` 命令）会上报为 Langfuse TEXT score，挂到该会话最近一轮 turn 的 trace 上（两种上传模式都生效）。
3. **子 agent 血缘**：子会话的 turn trace 会 link 到父会话最近的 turn trace（同进程尽力而为）。
4. **可开关的 generation input**：`includeGenerationInput` 把请求头（system prompt / 工具 schema / 模型）+ 本轮用户 prompt 导出为 generation 的 input。默认关闭——system prompt 敏感。

## 安装

```sh
dsh plugin --profile web add dsh-langfuse
export LANGFUSE_PUBLIC_KEY=pk-lf-…
export LANGFUSE_SECRET_KEY=sk-lf-…
export LANGFUSE_HOST=http://langfuse.example.com   # 自建实例；默认 https://cloud.langfuse.com
dsh web
```

自带 `cordis.patch.yml` 会禁用 dsh-base 的 `session-telemetry-otel` 行（seam 每个 context 只接受一个后端）并插入本包：有 key 默认 FULL 实时上报，无 key 默认 DISABLED（本地只读）。`LANGFUSE_TELEMETRY_MODE=FEEDBACK_ONLY` 收敛为「记录反馈时才上报」；`LANGFUSE_INCLUDE_GENERATION_INPUT=1` 打开 generation input。

也可用显式 cordis 行：

```yaml
- id: session-telemetry-langfuse
  name: dsh-langfuse
  config:
    mode: FULL                 # FULL | FEEDBACK_ONLY | DISABLED（默认）
    exporter:
      url: http://langfuse.example.com/api/public/otel/v1/traces
    auth:
      publicKey: !!js process.env.LANGFUSE_PUBLIC_KEY
      secretKey: !!js process.env.LANGFUSE_SECRET_KEY
    processor: {}
    includeGenerationInput: false
    maxAttributeChars: 16384
    shutdownTimeoutMillis: 3000
    feedbackScoreName: user-feedback
```

## 事件映射

| dsh 会话事件 | Langfuse 概念 |
|---|---|
| `turn/start` / `turn/end` | trace（根 span；错误结束 → ERROR 状态） |
| `step/start` + `request/header` + `assistant/message` | **generation**：模型/供应商/输出/`gen_ai.usage.*`（input/output/cache-read/reasoning），可选 input |
| 每步第一个 `assistant/chunk` | `langfuse.observation.completion_start_time`（首 token 时间） |
| `tool/call` + `tool/result` | tool span（入参尽量按模型原始 JSON 解析成对象；失败 → ERROR） |
| `user/message` | trace input |
| `feedback/record` | TEXT score（挂在最近 turn trace） |
| 子会话 turn | trace link 到父会话最近 turn trace |
| 其余事件类型 | 开放 turn 上的时间点 span event |

## 验证情况

- `npm run check`：biome + typecheck + 30 个单测/集成测试（seam 全链路 + 线上报文断言）+ 构建
- **真冒烟已通过**：临时 profile 挂本包直连 self-hosted Langfuse v3.171.0，headless 跑一轮任务 → trace 落库（generation 含模型、usage、缓存 token、首 token 时间、输出），全程无需网关侧或 node_modules 补丁；TEXT score 推送同样实测通过

## 已知限制

- seam 每 context 只接受一个后端（与官方 otel 后端二选一）
- 子 agent 血缘仅同进程（跨进程重启后父 trace id 未知）
- at-most-once 交付（崩溃窗口丢批；包内带 6 次退避重试压缩丢失窗口）
- score 推送为 fire-and-forget，失败只告警

## License

[MIT](LICENSE)
