/**
 * Configuration surface: the schemastery schema cordis validates, the
 * resolve step that turns it into a checked runtime shape, and the sharing
 * policy vocabulary. All fail-loud checks live here, so a deployment learns
 * about misconfiguration at plugin load, before any transport exists.
 *
 * @module dsh-langfuse/config
 */

import z from '@deepseek-ai/schemastery'
import type { BufferConfig } from '@opentelemetry/sdk-trace-base'
import { DEFAULT_MAX_ATTRIBUTE_CHARS } from './projection.js'
import { basicAuthHeader } from './transport.js'

/** Sharing policy selected by {@link Config.mode}. */
export enum DshLangfuseMode {
  FULL = 'FULL',
  FEEDBACK_ONLY = 'FEEDBACK_ONLY',
  DISABLED = 'DISABLED',
}

/** Default sharing policy: local-only. */
export const DEFAULT_MODE = DshLangfuseMode.DISABLED

/** Default outer allowance for the SDK's complete shutdown sequence. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MILLIS = 3_000

/** Default Langfuse score name for `feedback/record` pushes. */
export const DEFAULT_FEEDBACK_SCORE_NAME = 'user-feedback'

/** Default per-request timeout for the HTTP transport. */
export const DEFAULT_TIMEOUT_MILLIS = 10_000

// Node clamps larger timer delays to one millisecond. Runtime protocol
// limit, not a deployment default.
const MAX_TIMER_DELAY_MILLIS = 2_147_483_647

/**
 * Plugin configuration: one sharing policy, the Langfuse credentials, the
 * OTel SDK's batch knobs, and the dsh-langfuse-specific toggles.
 */
export interface Config {
  mode?: DshLangfuseMode
  exporter?: {
    /** Full traces endpoint, e.g. `https://cloud.langfuse.com/api/public/otel/v1/traces`. Required outside `DISABLED`. */
    url?: string
    /** Per-request timeout; defaults to 10s. */
    timeoutMillis?: number
  }
  /** Langfuse project key pair, turned into the endpoint's Basic-auth header. Required outside `DISABLED`. */
  auth?: {
    publicKey?: string
    secretKey?: string
  }
  /** Passed verbatim to `BatchSpanProcessor`; the SDK owns and documents these knobs. */
  processor?: BufferConfig
  /**
   * Export a generation input (request-header system prompt/tools/model plus
   * the turn's user prompt) on generation spans. Off by default: system
   * prompts are sensitive and the canonical log keeps the full bytes anyway.
   */
  includeGenerationInput?: boolean
  /** Serialized-payload ceiling per span attribute (characters). */
  maxAttributeChars?: number
  /** Maximum time spent awaiting the SDK provider's complete shutdown path. */
  shutdownTimeoutMillis?: number
  /** Langfuse score name for `feedback/record` pushes. */
  feedbackScoreName?: string
}

/** Schemastery validator; cordis runs it before the plugin starts. */
export const Config: z<Config> = z.object({
  mode: z.union(Object.values(DshLangfuseMode)).default(DEFAULT_MODE),
  exporter: z.any(),
  auth: z.any(),
  processor: z.any(),
  includeGenerationInput: z.boolean().default(false),
  maxAttributeChars: z.number(),
  shutdownTimeoutMillis: z.number(),
  feedbackScoreName: z.string().default(DEFAULT_FEEDBACK_SCORE_NAME),
})

/** Internal sharing policy: the enum mapped onto the seam's vocabulary. */
export type RuntimeMode = 'full' | 'feedback-only' | 'disabled'

/** Shared, always-present fields of a resolved configuration. */
interface CommonConfig {
  includeGenerationInput: boolean
  maxAttributeChars: number
  shutdownTimeoutMillis: number
  feedbackScoreName: string
}

/** Resolved configuration for a mode that never constructs a transport. */
export interface DisabledConfig extends CommonConfig {
  mode: 'disabled'
}

/** Resolved configuration for a mode that uploads traces. */
export interface UploadingConfig extends CommonConfig {
  mode: 'full' | 'feedback-only'
  /** Validated full OTLP traces endpoint. */
  url: string
  /** Endpoint origin, reused for the scores API. */
  origin: string
  /** Prebuilt Basic-auth header value. */
  authorization: string
  timeoutMillis: number
  processor?: BufferConfig
}

export type ResolvedConfig = DisabledConfig | UploadingConfig

/**
 * Validate and normalize a raw config. Uploading modes check the endpoint,
 * the credentials, and the numeric bounds and throw with field-naming error
 * messages; `DISABLED` resolves without reading any of them.
 */
export function resolveConfig(input: Config): ResolvedConfig {
  const mode = parseMode(input.mode)
  const common: CommonConfig = {
    includeGenerationInput: input.includeGenerationInput === true,
    maxAttributeChars: checkPositiveInt(
      'maxAttributeChars',
      input.maxAttributeChars ?? DEFAULT_MAX_ATTRIBUTE_CHARS,
    ),
    shutdownTimeoutMillis: checkShutdownTimeout(
      input.shutdownTimeoutMillis ?? DEFAULT_SHUTDOWN_TIMEOUT_MILLIS,
    ),
    feedbackScoreName: input.feedbackScoreName ?? DEFAULT_FEEDBACK_SCORE_NAME,
  }
  if (mode === 'disabled') return { mode, ...common }

  const url = input.exporter?.url
  if (url === undefined || url.length === 0) {
    throw new Error(
      'dsh-langfuse: exporter.url is required (the full OTLP traces endpoint, e.g. https://cloud.langfuse.com/api/public/otel/v1/traces)',
    )
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`dsh-langfuse: exporter.url is not a valid URL: ${JSON.stringify(url)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`dsh-langfuse: exporter.url must be http(s), got ${parsed.protocol}`)
  }
  const publicKey = input.auth?.publicKey
  const secretKey = input.auth?.secretKey
  if (
    publicKey === undefined ||
    publicKey.length === 0 ||
    secretKey === undefined ||
    secretKey.length === 0
  ) {
    throw new Error('dsh-langfuse: uploading modes require auth.publicKey and auth.secretKey')
  }
  const batchSize = input.processor?.maxExportBatchSize
  if (batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize < 1)) {
    throw new Error(
      `dsh-langfuse: processor.maxExportBatchSize must be a positive integer, got ${String(batchSize)}`,
    )
  }
  return {
    mode,
    url,
    origin: parsed.origin,
    authorization: basicAuthHeader(publicKey, secretKey),
    timeoutMillis: input.exporter?.timeoutMillis ?? DEFAULT_TIMEOUT_MILLIS,
    processor: input.processor,
    ...common,
  }
}

function parseMode(mode: DshLangfuseMode | undefined): RuntimeMode {
  const raw = mode ?? DEFAULT_MODE
  switch (raw) {
    case DshLangfuseMode.FULL:
      return 'full'
    case DshLangfuseMode.FEEDBACK_ONLY:
      return 'feedback-only'
    case DshLangfuseMode.DISABLED:
      return 'disabled'
    default:
      throw new Error(`dsh-langfuse: unknown mode ${JSON.stringify(raw)}`)
  }
}

function checkPositiveInt(field: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`dsh-langfuse: ${field} must be a positive integer, got ${String(value)}`)
  }
  return value
}

function checkShutdownTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MILLIS) {
    throw new Error(
      `dsh-langfuse: shutdownTimeoutMillis must be a positive finite number no greater than ${MAX_TIMER_DELAY_MILLIS}, got ${String(value)}`,
    )
  }
  return value
}
