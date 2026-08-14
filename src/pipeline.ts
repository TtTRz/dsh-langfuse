/**
 * ExportPipeline: assembles the OTel SDK pieces for one uploading backend —
 * a `BasicTracerProvider` with a `BatchSpanProcessor` over the
 * Content-Length exporter — and owns the shutdown sequence that sweeps open
 * spans closed and drains the SDK within a bounded deadline.
 *
 * @module dsh-langfuse/pipeline
 */

import { createRequire } from 'node:module'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import type { UploadingConfig } from './config.js'
import { ContentLengthSpanExporter } from './exporter.js'
import { SessionTimeline } from './projection.js'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

/** The SDK pipeline plus the timeline that feeds it, owned by the backend. */
export class ExportPipeline {
  readonly timeline: SessionTimeline
  private readonly provider: BasicTracerProvider
  private readonly shutdownTimeoutMillis: number

  constructor(resolved: UploadingConfig) {
    const exporter = new ContentLengthSpanExporter({
      url: resolved.url,
      authorization: resolved.authorization,
      timeoutMillis: resolved.timeoutMillis,
    })
    this.provider = new BasicTracerProvider({
      resource: resourceFromAttributes({
        'service.name': 'dsh-langfuse',
        'service.version': version,
      }),
      spanProcessors: [new BatchSpanProcessor(exporter, resolved.processor)],
    })
    this.timeline = new SessionTimeline(this.provider.getTracer('dsh-langfuse', version), {
      maxAttributeChars: resolved.maxAttributeChars,
      includeGenerationInput: resolved.includeGenerationInput,
    })
    this.shutdownTimeoutMillis = resolved.shutdownTimeoutMillis
  }

  /**
   * Close every open span, then ask the SDK to flush and quiesce — but give
   * up after the configured deadline: the SDK's export timeout does not
   * bound its preceding force-flush wait, which can stay pending forever on
   * a dead socket. The provider promise stays observed after the deadline so
   * a later rejection cannot become an unhandled rejection.
   */
  async drain(): Promise<void> {
    this.timeline.closeAll(Date.now())
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`dsh-langfuse: shutdown exceeded ${this.shutdownTimeoutMillis}ms`))
      }, this.shutdownTimeoutMillis)
    })
    try {
      await Promise.race([this.provider.shutdown(), deadline])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}
