# dsh-langfuse

[Langfuse](https://langfuse.com) observability for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): exports each agent session as an OpenTelemetry trace tree — turn → trace, model step → generation, tool call → tool span — with GenAI semantic-convention and `langfuse.*` attributes, to Langfuse's OTLP endpoint (`/api/public/otel/v1/traces`, which accepts **traces only** — the reason the official OTLP-*logs* backend cannot feed Langfuse).

The package is built on the harness's public telemetry seam (`@deepseek-ai/dsh-session-telemetry`) as an alternative backend, with four deliberate design choices:

1. **Content-Length transport.** Spans are delivered as one write with an explicit `Content-Length` header — never `Transfer-Encoding: chunked`. Some Langfuse deployments sit behind front gateways that mangle chunked POST bodies; Langfuse's OTLP route then fails them with `400 Failed to parse OTel JSON Trace` even though the bytes were valid (measured: chunked → 100% 400, Content-Length → 100% 200). The OTel SDK's own HTTP exporter always sends chunked and offers no switch; this package ships its own exporter instead, so no `node_modules` patch is needed on either side.
2. **Feedback scores.** `feedback/record` events (the harness's `/feedback` command) are pushed to Langfuse as TEXT scores on the session's latest turn trace, in both upload modes.
3. **Subagent lineage.** A subagent session's turn traces link to the parent session's latest turn trace (best-effort, same-process).
4. **Opt-in generation input.** `includeGenerationInput` exports a generation input built from the request header (system prompt, tool schemas, model) and the turn's user prompt. Off by default: system prompts are sensitive.

## Install

As a profile bundle (the package ships a `cordis.patch.yml` layer that disables the conflicting `session-telemetry-otel` row and mounts this backend):

```sh
dsh plugin --profile web add dsh-langfuse
export LANGFUSE_PUBLIC_KEY=pk-lf-…
export LANGFUSE_SECRET_KEY=sk-lf-…
# optional; defaults to https://cloud.langfuse.com (EU). This package reads
# LANGFUSE_HOST, not the Langfuse SDK's LANGFUSE_BASE_URL.
export LANGFUSE_HOST=https://us.cloud.langfuse.com
dsh web                        # alias for: dsh --profile web
```

With a key present the backend runs in `FULL` mode (live capture, every turn exported); without a key it is `DISABLED` (nothing constructed, nothing leaves the process). `LANGFUSE_TELEMETRY_MODE=FEEDBACK_ONLY` narrows sharing to feedback-gated release, and `LANGFUSE_INCLUDE_GENERATION_INPUT=1` turns on the generation-input export. Env vars and the bundle layer are read at boot: restart the instance from a shell that has them set. `dsh --profile web --dump-config` shows the composed result without booting; `dsh plugin --profile web remove dsh-langfuse` removes the dependency and the layer.

Or as an explicit `cordis.yml` row:

```yaml
- id: session-telemetry-langfuse
  name: dsh-langfuse
  config:
    mode: FULL                 # FULL | FEEDBACK_ONLY | DISABLED (default)
    exporter:
      url: https://cloud.langfuse.com/api/public/otel/v1/traces
      timeoutMillis: 10000
    auth:                      # Langfuse project key pair (Basic auth)
      publicKey: !!js process.env.LANGFUSE_PUBLIC_KEY
      secretKey: !!js process.env.LANGFUSE_SECRET_KEY
    processor: {}              # optional; passed verbatim to BatchSpanProcessor
    includeGenerationInput: false
    maxAttributeChars: 16384
    shutdownTimeoutMillis: 3000
    feedbackScoreName: user-feedback
```

## Config

| Field | Meaning |
|---|---|
| `mode` | `FULL` exports every session live; `FEEDBACK_ONLY` replays and exports the canonical session log only when the user records feedback; `DISABLED` (default) constructs nothing and nothing leaves the process. The vocabulary and consent semantics are the seam's, identical to the official backend. |
| `exporter` | Transport knobs. `url` is required outside `DISABLED` and must be the **full traces path** (`…/api/public/otel/v1/traces`). `timeoutMillis` defaults to 10s. |
| `auth` | Langfuse project key pair, turned into the endpoint's Basic-auth header. Uploading modes require both keys. |
| `processor` | Passed verbatim to `BatchSpanProcessor` (`scheduledDelayMillis`, `maxQueueSize`, `maxExportBatchSize`, …); batching and queueing are the SDK's documented behavior. Retries (bounded exponential backoff, 6 attempts by default) live in this package's exporter. |
| `includeGenerationInput` | Export `langfuse.observation.input` on generation spans (request-header system prompt/tools/model + the turn's user prompt). Off by default. |
| `maxAttributeChars` | Serialized-payload ceiling per span attribute (default 16384); longer payloads are truncated with a `…[truncated]` marker while the canonical session log keeps the full bytes. |
| `shutdownTimeoutMillis` | Outer deadline on the SDK's shutdown drain (default 3000). |
| `feedbackScoreName` | Langfuse score name for `feedback/record` pushes (default `user-feedback`). |

Misconfiguration fails loud at plugin load: a missing/malformed/non-http(s) `url`, missing credentials, a non-positive `maxExportBatchSize` (the SDK would hang on shutdown), or an unknown `mode` all throw before any transport is constructed.

## What appears in Langfuse

| dsh session event | Langfuse concept |
|---|---|
| session (`session.id`) | session (`langfuse.session.id` on every trace) |
| `turn/start` / `turn/end` | trace (`turn N`; error end reasons set span status ERROR) |
| `step/start` / `step/end` + `request/header` + `assistant/message` | **generation** (`step T.S`) — model, provider, output, `gen_ai.usage.*` tokens (input/output/cache-read/reasoning), optional input |
| first `assistant/chunk` of a step | `langfuse.observation.completion_start_time` (time-to-first-token) |
| `tool/call` + `tool/result` | tool span (arguments as input — parsed from the model's JSON string when possible, result as output, `isError` → status ERROR) |
| `user/message` | trace input |
| `feedback/record` | TEXT score on the session's latest turn trace (both upload modes) |
| subagent session's turns | trace links to the parent session's latest turn trace (same-process) |
| `agent-error` ops record | exception event + status ERROR on the open turn |
| every other event type (todo, plan, compaction, hooks, plugin events) | point-in-time span event on the open turn |

Correlation attributes use this package's own vocabulary — `dsh.turn_idx`, `dsh.step_idx`, `dsh.event_seq`, `dsh.turn_end`, `dsh.forced_end`, `dsh.parent_session` — deliberately distinct from other dsh telemetry backends so several can share one Langfuse project without attribute collisions.

## Architecture

- **A telemetry-seam backend, not agent-loop or LLM-layer instrumentation.** The harness's rule is *model-visible ⟺ logged*: everything that reaches a model request is reconstructable from the canonical session log. Implementing `SessionTelemetryBackend` buys capture of everything model-visible (including events this package has never heard of), the `session-telemetry/record` redaction waterfall, `FEEDBACK_ONLY` consent semantics, and the handoff cursor — for free and with guaranteed consistency.
- **Plain OTel traces SDK, not the Langfuse SDK.** Spans are built with the OTel SDK (`BasicTracerProvider` → `BatchSpanProcessor`) and serialized with `@opentelemetry/otlp-transformer`; a custom `SpanExporter` delivers the JSON with `Content-Length` and bounded retries. Layout: `config.ts` (fail-loud validation) → `pipeline.ts` (SDK assembly + bounded shutdown drain) → `backend.ts` (cordis service, capture modes, feedback relay) → `projection.ts` (`SessionTimeline` folding state machine).
- **A folding timeline.** The seam hands over a flat record stream; Langfuse needs a tree. `SessionTimeline` replays records into spans keyed by `(session.id, turn, step)`. Timestamps always come from the record's own time, never the wall clock, so live capture and canonical-log replay produce identical trees. `seq` gaps are routine, never a loss signal. Unknown event types land as span events on the open turn. Force-end sweeps close still-open spans on a next `turn/start` with an open predecessor, on the session's ops `shutdown` record, and on backend shutdown.
- **Delivery semantics: at-most-once handoff, duplicates possible** (inherited from the seam). The exporter's bounded retries keep the loss window to the crash window only; receivers correlate on `langfuse.session.id` + `dsh.turn_idx` + `dsh.event_seq`.
- **What leaves the machine.** In uploading modes, span attributes carry user and assistant message content, tool arguments and results, and model/usage metadata, as returned by the `session-telemetry/record` waterfall. This package ships no redaction rules; a deployment exporting beyond a trusted boundary mounts its own waterfall listener. Provider API keys are structurally absent (they are constructor parameters, never session events).

## Model Experience

None. This plugin only observes the session stream through the telemetry seam and hands folded spans to the OTel SDK; it never contributes to a model request and never assembles or sends a provider request.

## Testing

```sh
npm run check        # biome + typecheck + vitest (unit & seam integration) + build
```

The suite covers config validation, the folding timeline (hierarchy, attributes, error statuses, force-end sweeps, first-chunk dedupe, lineage links, truncation), the transport (`Content-Length` present, no `Transfer-Encoding`, retry/backoff behavior), score pushes, and a full seam integration that drives a real `SessionTelemetryCoordinator` over a Cordis context and asserts the wire payload.

A real-deployment smoke against a self-hosted Langfuse (v3.171.0) was run from a sandbox profile: one headless task produced a `turn 1` trace with a GENERATION observation carrying model, usage (including cache-read tokens), completion-start time, and output — delivered direct, without any gateway-side or `node_modules` patches.

## Version compatibility

DeepSeek Harness is in developer preview with no compatibility promises; this package pins exact `@deepseek-ai/dsh-*` versions.

| dsh-langfuse | @deepseek-ai/dsh-* |
|---|---|
| 0.1.x | 0.1.0-rc.6 |

## Known limitations

- **One backend per context**: running Langfuse *and* the official OTLP-logs backend simultaneously requires a multi-sink evolution of the upstream seam.
- **Subagent lineage is same-process best-effort**: a resumed parent's trace id is unknown across restarts, so no link is stitched then.
- **No durable delivery** (at-most-once, see above).
- **Score pushes are fire-and-forget**: a failed push logs a warning and never disturbs the session.

## License

[MIT](LICENSE)
