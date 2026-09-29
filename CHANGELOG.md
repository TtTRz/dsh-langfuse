# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-09-29

### Changed

- Require DeepSeek Harness 0.1.7-rc.2. Session and telemetry SDKs are exact peer dependencies supplied by the host; the plugin no longer installs telemetry 0.1.0-rc.6 as a private runtime dependency.

### Fixed

- Prevent plugin installation from bringing back an incompatible telemetry SDK that throws `session.events is not iterable` while creating or restoring sessions.
- Use the rc.2 capture-options object so `FEEDBACK_ONLY` remains dormant until canonical feedback is recorded.
- Read canonical feedback through the session accessor instead of the removed `events` getter; support category-only and text-free feedback.
- Adapt tool-result messages and first-token timing to the rc.2 message and embedded-stream contracts.

### Added

- Real rc.2 session regression tests and a fresh-profile installation smoke test, including reinstall, session creation, and reopening.
- GitHub Actions checks for formatting, types, unit tests, build, and packed-plugin installation.


## [0.1.1] - 2026-08-15

### Changed

- READMEs (EN/ZH) rewritten in the popular GitHub style: badges, quick-start-first layout, feature cards, and compact config/mapping tables.
- Docs polish: one-sentence package description, no internal-host references, and the bundled NOTICE removed (the tarball no longer carries third-party attribution files).

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
