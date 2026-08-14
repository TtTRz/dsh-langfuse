# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-15

### Added

- `SessionTelemetryBackend` for the DeepSeek Harness telemetry seam: exports each session as an OTel trace tree (turn → trace, step → generation, tool → span) with GenAI semantic-convention and `langfuse.*` attributes to Langfuse's OTLP endpoint.
- Custom `SpanExporter` delivering OTLP/JSON as a single write with an explicit `Content-Length` header — sidesteps gateways that mangle `Transfer-Encoding: chunked` POST bodies (verified against a self-hosted Langfuse v3.171.0 that rejects chunked uploads with `400 Failed to parse OTel JSON Trace`).
- Bounded exponential-backoff retries inside the exporter (6 attempts by default) before reporting failure to `BatchSpanProcessor`.
- `feedback/record` → Langfuse TEXT score on the session's latest turn trace, in both `FULL` and `FEEDBACK_ONLY` modes.
- Subagent lineage: child session turn traces link to the parent session's latest turn trace (same-process).
- Opt-in generation input export (`includeGenerationInput`): request-header system prompt/tools/model plus the turn's user prompt.
- Three sharing modes (`FULL` / `FEEDBACK_ONLY` / `DISABLED`, default `DISABLED`), env-driven bundle patch (`LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_TELEMETRY_MODE`, `LANGFUSE_INCLUDE_GENERATION_INPUT`), and fail-loud config validation.
- Unit and seam-integration test suite (30 tests) plus a real-deployment smoke against a self-hosted Langfuse (v3.171.0).
