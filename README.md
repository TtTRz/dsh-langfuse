# dsh-langfuse

> Langfuse LLM observability for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — one OpenTelemetry trace tree per agent session, with feedback scores and subagent lineage.

[![npm version](https://img.shields.io/npm/v/dsh-langfuse)](https://www.npmjs.com/package/dsh-langfuse)
[![license](https://img.shields.io/npm/l/dsh-langfuse)](LICENSE)
[![node](https://img.shields.io/node/v/dsh-langfuse)](https://nodejs.org)
[![downloads](https://img.shields.io/npm/dm/dsh-langfuse)](https://www.npmjs.com/package/dsh-langfuse)

Send every agent session to [Langfuse](https://langfuse.com) as an OpenTelemetry trace tree — **turn → trace**, **model step → generation**, **tool call → tool span** — with GenAI semantic-convention attributes, token usage, time-to-first-token, and error statuses.

## ✨ Features

- 🧵 **Full session tracing** — every turn, generation, and tool call lands in Langfuse with model, provider, usage (incl. cache-read & reasoning tokens), and TTFT.
- 🚚 **Content-Length transport** — spans are delivered as a single write with an explicit `Content-Length` header, never chunked. Some Langfuse deployments sit behind gateways that mangle chunked POST bodies (`400 Failed to parse OTel JSON Trace`); this transport sidesteps that class of bugs entirely.
- 👍 **Feedback scores** — `/feedback` records become TEXT scores on the session's latest turn trace.
- 🔗 **Subagent lineage** — child-session turn traces link to the parent session's trace (same-process).
- 🎚️ **Three sharing modes** — `FULL` (live), `FEEDBACK_ONLY` (export only when the user records feedback), `DISABLED` (default; nothing leaves the process).
- 🔒 **Opt-in inputs** — generation input (system prompt / tools / prompt) is exported only when `includeGenerationInput` is on.
- 🛡️ **Fail-loud config** — bad URLs, missing keys, and invalid bounds throw at plugin load, before any transport exists.

## 🚀 Quick Start

```sh
dsh plugin --profile web add dsh-langfuse

export LANGFUSE_PUBLIC_KEY=pk-lf-...
export LANGFUSE_SECRET_KEY=sk-lf-...
# optional: self-hosted or non-EU region
export LANGFUSE_HOST=https://langfuse.example.com

dsh web   # restart the running instance, then take a turn
```

With a key present the backend runs in `FULL` mode; without one it is `DISABLED`. `LANGFUSE_TELEMETRY_MODE=FEEDBACK_ONLY` narrows sharing to feedback-gated release, and `LANGFUSE_INCLUDE_GENERATION_INPUT=1` exports generation inputs.

The bundled patch disables the base profile's `session-telemetry-otel` row (the telemetry seam accepts exactly one backend per context) and mounts this one. `dsh --profile web --dump-config` shows the composed result without booting.

### As an explicit `cordis.yml` row

```yaml
- id: session-telemetry-langfuse
  name: dsh-langfuse
  config:
    mode: FULL                 # FULL | FEEDBACK_ONLY | DISABLED (default)
    exporter:
      url: https://cloud.langfuse.com/api/public/otel/v1/traces
    auth:
      publicKey: !!js process.env.LANGFUSE_PUBLIC_KEY
      secretKey: !!js process.env.LANGFUSE_SECRET_KEY
    processor: {}              # optional; passed verbatim to BatchSpanProcessor
    includeGenerationInput: false
```

## ⚙️ Configuration

| Field | Default | Meaning |
|---|---|---|
| `mode` | `DISABLED` | `FULL` exports every session live; `FEEDBACK_ONLY` exports the canonical session log only when feedback is recorded; `DISABLED` constructs nothing. |
| `exporter.url` | — | Full OTLP traces endpoint (`…/api/public/otel/v1/traces`). Required unless `DISABLED`. |
| `exporter.timeoutMillis` | `10000` | Per-request timeout. |
| `auth.publicKey` / `auth.secretKey` | — | Langfuse project key pair (Basic auth). Required unless `DISABLED`. |
| `processor` | `{}` | Passed verbatim to `BatchSpanProcessor` (`scheduledDelayMillis`, `maxQueueSize`, …). Retries (bounded backoff, 6 attempts) live in the exporter. |
| `includeGenerationInput` | `false` | Export `langfuse.observation.input` (system prompt / tool schemas / model / user prompt). |
| `maxAttributeChars` | `16384` | Per-attribute payload ceiling; longer payloads are truncated with a `…[truncated]` marker (the canonical log keeps the full bytes). |
| `shutdownTimeoutMillis` | `3000` | Deadline on the SDK's shutdown drain. |
| `feedbackScoreName` | `user-feedback` | Langfuse score name for `/feedback` pushes. |

## 🧭 What appears in Langfuse

| dsh session event | Langfuse concept |
|---|---|
| `turn/start` / `turn/end` | trace (`turn N`; error end reasons → ERROR status) |
| `step/start` + `request/header` + `assistant/message` | **generation** (`step T.S`) — model, provider, output, `gen_ai.usage.*` tokens |
| first `assistant/chunk` of a step | `langfuse.observation.completion_start_time` (TTFT) |
| `tool/call` + `tool/result` | tool span (arguments → input, result → output, `isError` → ERROR) |
| `user/message` | trace input |
| `feedback/record` | TEXT score on the session's latest turn trace |
| subagent session turns | trace links to the parent session's trace |
| `agent-error` ops record | exception event + ERROR status |
| every other event type (todo, plan, compaction, …) | span event on the open turn |

Correlation attributes use this package's own vocabulary (`dsh.turn_idx`, `dsh.step_idx`, `dsh.event_seq`, …) so multiple telemetry backends can share one Langfuse project without attribute collisions.

## 🏗️ How it works

- **A telemetry-seam backend.** The harness logs everything model-visible to the canonical session log; this plugin implements `SessionTelemetryBackend` (`@deepseek-ai/dsh-session-telemetry`), so it captures every event — including ones it has never heard of — with the seam's consent semantics and redaction waterfall for free.
- **OTel SDK + custom exporter.** Spans are built with `BasicTracerProvider` + `BatchSpanProcessor`, serialized with `@opentelemetry/otlp-transformer`, and delivered by a custom `SpanExporter` with `Content-Length` and bounded retries.
- **A folding timeline.** `SessionTimeline` replays the flat record stream into span trees keyed by `(session.id, turn, step)`. Span boundaries always use the record's own timestamp — live capture and canonical-log replay produce identical trees.
- **At-most-once delivery** (inherited from the seam): the loss window is the crash window; receivers correlate on `langfuse.session.id` + `dsh.turn_idx` + `dsh.event_seq`.

## 🧪 Development

```sh
npm run check   # biome + typecheck + vitest (unit & seam integration) + build
```

30 tests cover config validation, the folding timeline, the transport (`Content-Length`, no `Transfer-Encoding`, retry/backoff), score pushes, and a full seam integration that drives a real `SessionTelemetryCoordinator` and asserts the wire payload.

## ⚠️ Limitations

- One backend per context (the seam throws on duplicates — the bundled patch disables the official OTLP-logs row).
- Subagent lineage is same-process best-effort (a resumed parent's trace id is unknown across restarts).
- No durable delivery (at-most-once).
- Score pushes are fire-and-forget (failures only log).

## 📄 License

[MIT](LICENSE)
