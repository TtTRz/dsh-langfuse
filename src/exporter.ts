/**
 * A `SpanExporter` that serializes spans as OTLP/JSON (GenAI semantic
 * conventions included) and delivers them over {@link postJson} — single
 * write, explicit `Content-Length`, no chunked transfer.
 *
 * Retries happen inside the exporter (exponential backoff, bounded attempts)
 * because `BatchSpanProcessor` drops the batch when an export reports
 * failure; making the transport retry before reporting keeps the at-most-once
 * loss window small without changing the SDK's queue semantics.
 *
 * @module dsh-langfuse/exporter
 */

import { type ExportResult, ExportResultCode } from '@opentelemetry/core'
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer'
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { postJson } from './transport.js'

export interface ContentLengthExporterOptions {
  /** Full OTLP traces endpoint, e.g. `https://cloud.langfuse.com/api/public/otel/v1/traces`. */
  url: string
  /** Prebuilt `Authorization` header value; omitted when undefined. */
  authorization?: string
  timeoutMillis?: number
  /** Total POST attempts per export, retries included. */
  maxAttempts?: number
  /** Per-attempt backoff delays (milliseconds); the last entry repeats. */
  backoffMillis?: readonly number[]
}

const DEFAULT_MAX_ATTEMPTS = 6
const DEFAULT_BACKOFF_MILLIS = [200, 500, 1000, 2000, 5000] as const
const DEFAULT_TIMEOUT_MILLIS = 10_000

export class ContentLengthSpanExporter implements SpanExporter {
  private readonly url: string
  private readonly authorization?: string
  private readonly timeoutMillis: number
  private readonly maxAttempts: number
  private readonly backoffMillis: readonly number[]
  private readonly pending = new Map<NodeJS.Timeout, () => void>()
  private readonly inFlight = new Set<Promise<void>>()
  private stopped = false

  constructor(options: ContentLengthExporterOptions) {
    this.url = options.url
    this.authorization = options.authorization
    this.timeoutMillis = options.timeoutMillis ?? DEFAULT_TIMEOUT_MILLIS
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
    this.backoffMillis = options.backoffMillis ?? DEFAULT_BACKOFF_MILLIS
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.stopped || spans.length === 0) {
      resultCallback({ code: ExportResultCode.SUCCESS })
      return
    }
    const task = this.sendWithRetries(spans).then((delivered) => {
      this.inFlight.delete(task)
      resultCallback(
        delivered
          ? { code: ExportResultCode.SUCCESS }
          : {
              code: ExportResultCode.FAILED,
              error: new Error(`dsh-langfuse: export failed after ${this.maxAttempts} attempts`),
            },
      )
    })
    this.inFlight.add(task)
  }

  private async sendWithRetries(spans: ReadableSpan[]): Promise<boolean> {
    const serialized = JsonTraceSerializer.serializeRequest(spans)
    if (serialized === undefined) return false
    const body = Buffer.from(serialized)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'dsh-langfuse-otlp/0.1.0',
    }
    if (this.authorization !== undefined) headers.authorization = this.authorization
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const outcome = await postJson({
        url: this.url,
        headers,
        body,
        timeoutMillis: this.timeoutMillis,
      })
      if (outcome.status === 'success') return true
      if (outcome.status !== 'retryable' || attempt === this.maxAttempts) return false
      await this.sleep(this.backoffMillis[Math.min(attempt, this.backoffMillis.length) - 1] ?? 1000)
    }
    return false
  }

  private sleep(millis: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(timer)
        resolve()
      }, millis)
      this.pending.set(timer, resolve)
    })
  }

  forceFlush(): Promise<void> {
    return Promise.allSettled([...this.inFlight]).then(() => undefined)
  }

  shutdown(): Promise<void> {
    this.stopped = true
    for (const [timer, resolve] of this.pending) {
      clearTimeout(timer)
      resolve()
    }
    this.pending.clear()
    return Promise.allSettled([...this.inFlight]).then(() => undefined)
  }
}
