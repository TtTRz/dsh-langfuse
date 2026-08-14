/**
 * The cordis entry point: registers the `sessionTelemetry` backend service
 * (a duplicate backend load throws — the bundled `cordis.patch.yml` disables
 * the base profile's OTLP-logs row) and wires capture, replay, and
 * feedback-score push according to the resolved sharing mode.
 *
 * - `full`: a live coordinator streams every captured record into the
 *   timeline; direct service emits go there too.
 * - `feedback-only`: an on-demand coordinator keeps capture dormant until a
 *   canonical `feedback/record` event arrives, then replays the session log
 *   through the cursor and releases it.
 * - `disabled`: nothing is constructed and nothing leaves the process;
 *   recorded feedback is warned about so it is not silently lost.
 *
 * @module dsh-langfuse/backend
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-command-feedback'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import {
  SessionTelemetryBackend,
  SessionTelemetryCoordinator,
  type SessionTelemetryRecord,
  type SessionTelemetrySharingStatus,
  type SessionTelemetrySink,
} from '@deepseek-ai/dsh-session-telemetry'
import {
  Config,
  type Config as PluginConfig,
  resolveConfig,
  type UploadingConfig,
} from './config.js'
import { ExportPipeline } from './pipeline.js'
import { pushFeedbackScore } from './score.js'

const NOOP = (): void => {}

/** Sharing vocabulary expected by the seam, keyed by runtime mode. */
const SHARING_BY_MODE: Record<UploadingConfig['mode'] | 'disabled', SessionTelemetrySharingStatus> =
  {
    full: 'full',
    'feedback-only': 'feedback-only',
    disabled: 'disabled',
  }

/**
 * Bridges `feedback/record` events to Langfuse: releases an on-demand
 * capture when the mode requires it, then pushes a TEXT score onto the
 * session's latest turn trace. Every failure path only logs — a score must
 * never disturb the session it annotates.
 */
class FeedbackRelay {
  constructor(
    private readonly ctx: Context,
    private readonly resolved: UploadingConfig,
    private readonly pipeline: ExportPipeline,
    private readonly capture: SessionTelemetryCoordinator,
  ) {}

  install(): void {
    this.ctx.on('session/event', (session, event) => {
      if (event.type !== 'feedback/record') return
      // Consent is the committed record, not an independently emitted bus value.
      if (session.events[event.seq] !== event) {
        this.ctx.logger.warn('dsh-langfuse: feedback event is not in the canonical log; ignored')
        return
      }
      if (this.resolved.mode === 'feedback-only') this.capture.captureSession(session, event.seq)
      this.pushScore(session, event)
    })
  }

  private pushScore(session: Session, event: SessionEvent): void {
    if (event.type !== 'feedback/record') return
    const traceId = this.pipeline.timeline.traceIdFor(String(session.id))
    if (traceId === undefined) {
      this.ctx.logger.warn('dsh-langfuse: no turn trace to attach the feedback score to')
      return
    }
    pushFeedbackScore({
      baseUrl: this.resolved.origin,
      authorization: this.resolved.authorization,
      traceId,
      name: this.resolved.feedbackScoreName,
      text: event.data.text,
    }).catch((error: unknown) => {
      this.ctx.logger.warn(`dsh-langfuse: score push failed: ${String(error)}`)
    })
  }
}

/** The backend plugin — the only entry a deployment loads. */
export class DshLangfuseBackend extends SessionTelemetryBackend {
  static inject = ['sessions']
  static Config = Config

  override readonly sharing: SessionTelemetrySharingStatus
  private readonly feed: (record: SessionTelemetryRecord) => void
  private readonly pipeline: ExportPipeline | undefined

  constructor(ctx: Context, config: PluginConfig) {
    super(ctx)
    const resolved = resolveConfig(config)
    this.sharing = SHARING_BY_MODE[resolved.mode]
    if (resolved.mode === 'disabled') {
      this.feed = NOOP
      this.pipeline = undefined
      ctx.on('session/event', (_session, event) => {
        if (event.type === 'feedback/record') {
          ctx.logger.warn('dsh-langfuse is DISABLED; feedback stays local')
        }
      })
      return
    }
    const pipeline = new ExportPipeline(resolved)
    this.pipeline = pipeline
    const sink: SessionTelemetrySink = {
      emit: (record) => pipeline.timeline.fold(record),
      shutdown: () => this.shutdown(),
    }
    const capture = new SessionTelemetryCoordinator(
      ctx,
      sink,
      resolved.mode === 'full' ? 'live' : 'on-demand',
    )
    this.feed = resolved.mode === 'full' ? (record) => pipeline.timeline.fold(record) : NOOP
    new FeedbackRelay(ctx, resolved, pipeline, capture).install()
  }

  /**
   * Hand a direct service record to the timeline only in `full`. Direct
   * calls are no-ops in `feedback-only` and `disabled`; feedback replay uses
   * the private sink created for the canonical feedback listener.
   */
  emit(record: SessionTelemetryRecord): void {
    this.feed(record)
  }

  /** Sweep and drain the SDK pipeline; resolves immediately when disabled. */
  async shutdown(): Promise<void> {
    await this.pipeline?.drain()
  }
}

export default DshLangfuseBackend
