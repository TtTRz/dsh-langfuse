/**
 * dsh-langfuse: Langfuse observability for the DeepSeek Harness telemetry
 * seam. The default export is the cordis backend plugin; the named exports
 * cover the config surface and the standalone pieces (exporter, timeline,
 * transport, score push) for composition and testing.
 *
 * @module dsh-langfuse
 */

import { DshLangfuseBackend } from './backend.js'

export { DshLangfuseBackend } from './backend.js'
export {
  Config,
  type Config as PluginConfig,
  DEFAULT_FEEDBACK_SCORE_NAME,
  DEFAULT_MODE,
  DEFAULT_SHUTDOWN_TIMEOUT_MILLIS,
  type DisabledConfig,
  DshLangfuseMode,
  type ResolvedConfig,
  resolveConfig,
  type UploadingConfig,
} from './config.js'
export { type ContentLengthExporterOptions, ContentLengthSpanExporter } from './exporter.js'
export {
  DEFAULT_MAX_ATTRIBUTE_CHARS,
  type LineageEntry,
  SessionTimeline,
  type TimelineOptions,
  TRUNCATION_MARK,
} from './projection.js'
export { type PushScoreOptions, pushFeedbackScore } from './score.js'
export { basicAuthHeader, type PostOptions, type PostOutcome, postJson } from './transport.js'

export default DshLangfuseBackend
