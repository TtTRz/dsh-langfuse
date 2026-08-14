/**
 * SessionTimeline: replays the telemetry seam's flat record stream into one
 * OTel trace tree per session — a root span per turn, a generation span per
 * model step, and a tool span per tool call nested under its step — so
 * Langfuse receives hierarchical observations.
 *
 * Design rules, taken from the seam contract itself
 * (`@deepseek-ai/dsh-session-telemetry`, 0.1.0-rc.6) and Langfuse's
 * documented OTLP property mapping:
 *
 * - records are authoritative about time: every span boundary uses the
 *   record's own timestamp, never the wall clock, so live capture and
 *   canonical-log replay build identical trees;
 * - the seam ships exactly one `assistant/chunk` per (turn, step) — the
 *   stream-start signal, whose time is the first-token time;
 * - a turn without its `turn/end` is a crash window, not a semantic gap:
 *   the next `turn/start`, the session's shutdown record, or the backend's
 *   final sweep closes whatever is still open and flags it `dsh.forced_end`;
 * - event types without a dedicated mapping (todo, plan, compaction, plugin
 *   events) become span events on the open turn so the timeline stays
 *   complete; between turns they are dropped (the log keeps them).
 *
 * @module dsh-langfuse/timeline
 */

import type { SessionEventMap } from '@deepseek-ai/dsh-session'
import type { SessionTelemetryRecord } from '@deepseek-ai/dsh-session-telemetry'
import {
  type Context as OtelContext,
  ROOT_CONTEXT,
  type Span,
  SpanStatusCode,
  TraceFlags,
  type Tracer,
  trace,
} from '@opentelemetry/api'
import {
  ATTR_DSH_EVENT_SEQ,
  ATTR_DSH_FORCE_ENDED,
  ATTR_DSH_PARENT_SESSION,
  ATTR_DSH_STEP,
  ATTR_DSH_TURN,
  ATTR_DSH_TURN_END_REASON,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_USAGE_CACHE_READ_TOKENS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_USAGE_REASONING_TOKENS,
  ATTR_LANGFUSE_COMPLETION_START_TIME,
  ATTR_LANGFUSE_OBSERVATION_INPUT,
  ATTR_LANGFUSE_OBSERVATION_OUTPUT,
  ATTR_LANGFUSE_OBSERVATION_TYPE,
  ATTR_LANGFUSE_SESSION_ID,
  ATTR_LANGFUSE_TRACE_INPUT,
  ATTR_LANGFUSE_TRACE_NAME,
} from './semconv.js'

/** Default serialized-payload ceiling per span attribute (characters). */
export const DEFAULT_MAX_ATTRIBUTE_CHARS = 16_384

/** Payloads longer than the budget are cut here and marked with this suffix. */
export const TRUNCATION_MARK = '…[truncated]'

export interface TimelineOptions {
  /** Per-attribute serialized payload ceiling; longer payloads are truncated. */
  maxAttributeChars: number
  /**
   * When true, generation spans also carry `langfuse.observation.input`
   * built from the request header (system prompt, tool schemas, model) and
   * the turn's user prompt. Off by default: system prompts are sensitive.
   */
  includeGenerationInput: boolean
}

/** Trace identity of a session's latest turn root span, for scores and links. */
export interface LineageEntry {
  traceId: string
  spanId: string
}

/** One open model step: its generation span plus the first-token stamp. */
interface Generation {
  span: Span
  context: OtelContext
  firstChunkAt?: number
}

/** One open turn: the root span and everything currently nested under it. */
interface OpenTurn {
  root: Span
  context: OtelContext
  index: number
  generations: Map<number, Generation>
  tools: Map<string, Span>
  active?: Generation
}

/** Per-session replay state. */
interface Journal {
  id: string
  header?: SessionEventMap['request/header']['header']
  promptText?: string
  turn?: OpenTurn
}

type EventHandler = (journal: Journal, record: SessionTelemetryRecord) => void

function payload<T extends keyof SessionEventMap>(
  record: SessionTelemetryRecord,
): SessionEventMap[T] {
  return record.body as SessionEventMap[T]
}

/** Concatenate the plain-text blocks of a user message, if any. */
function plainText(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const content = (value as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  const parts = content
    .filter(
      (block): block is { text: unknown } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text',
    )
    .map((block) => String(block.text ?? ''))
    .filter((text) => text.length > 0)
  return parts.length > 0 ? parts.join('\n') : undefined
}

/** Best-effort structured parse: JSON text becomes data, anything else stays as-is. */
function structured(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/**
 * Replays seam records into OTel spans through the given tracer. One
 * instance serves every session the backend observes; per-session state dies
 * with the session's shutdown record or {@link closeAll}.
 */
export class SessionTimeline {
  private readonly journals = new Map<string, Journal>()
  private readonly traces = new Map<string, LineageEntry>()
  private readonly handlers: Record<string, EventHandler>

  constructor(
    private readonly tracer: Tracer,
    private readonly options: TimelineOptions,
  ) {
    this.handlers = {
      'request/header': this.rememberHeader,
      'turn/start': this.beginTurn,
      'turn/end': this.endTurn,
      'user/message': this.rememberPrompt,
      'step/start': this.beginGeneration,
      'step/end': this.endGeneration,
      'assistant/chunk': this.stampFirstChunk,
      'assistant/message': this.recordGenerationResult,
      'tool/call': this.beginTool,
      'tool/result': this.endTool,
    }
  }

  /** Latest turn trace id for a session, for feedback-score targeting. */
  traceIdFor(sessionId: string): string | undefined {
    return this.traces.get(sessionId)?.traceId
  }

  /** Attribute-safe serialization with the configured truncation budget. */
  serialize(value: unknown): string {
    const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? 'null')
    const budget = this.options.maxAttributeChars
    return text.length <= budget ? text : `${text.slice(0, budget)}${TRUNCATION_MARK}`
  }

  /** Replay one record; unknown event types land as span events on the open turn. */
  fold(record: SessionTelemetryRecord): void {
    if (record.channel === 'ops') {
      this.applyOps(record)
      return
    }
    const id = String(record.attributes['session.id'])
    const journal = this.journals.get(id) ?? { id }
    this.journals.set(id, journal)
    const handler = this.handlers[String(record.attributes['event.type'])]
    if (handler !== undefined) {
      handler(journal, record)
      return
    }
    journal.turn?.root.addEvent(
      String(record.attributes['event.type']),
      { [ATTR_DSH_EVENT_SEQ]: record.attributes['event.seq'] },
      record.time,
    )
  }

  /** Close every open span — the backend's final sweep before SDK shutdown. */
  closeAll(at: number): void {
    for (const [id, journal] of this.journals) {
      if (journal.turn !== undefined) this.closeTurn(journal, at, true)
      this.journals.delete(id)
    }
  }

  // ── event handlers ─────────────────────────────────────────────────────

  private readonly rememberHeader: EventHandler = (journal, record) => {
    journal.header = payload<'request/header'>(record).header
    // The header lands inside its step, after step/start: stamp the model
    // identity onto the step that is already open.
    const active = journal.turn?.active
    if (active !== undefined && journal.header !== undefined) {
      const config = journal.header.config as { model?: string; provider?: string }
      active.span.setAttribute(ATTR_GEN_AI_REQUEST_MODEL, config.model ?? '')
      active.span.setAttribute(ATTR_GEN_AI_PROVIDER_NAME, config.provider ?? '')
    }
  }

  private readonly beginTurn: EventHandler = (journal, record) => {
    const { turn } = payload<'turn/start'>(record)
    if (journal.turn !== undefined) this.closeTurn(journal, record.time, true)
    const root = this.tracer.startSpan(
      `turn ${turn}`,
      {
        startTime: record.time,
        root: true,
        attributes: {
          [ATTR_LANGFUSE_SESSION_ID]: journal.id,
          [ATTR_LANGFUSE_TRACE_NAME]: `turn ${turn}`,
          [ATTR_DSH_TURN]: turn,
          [ATTR_DSH_EVENT_SEQ]: record.attributes['event.seq'],
        },
      },
      ROOT_CONTEXT,
    )
    // Best-effort subagent lineage: link this trace to the parent session's
    // latest turn when the parent ran in this process.
    const parentId = record.attributes['session.parent_id']
    if (typeof parentId === 'string') {
      const parent = this.traces.get(parentId)
      if (parent !== undefined) {
        root.addLink({
          context: {
            traceId: parent.traceId,
            spanId: parent.spanId,
            traceFlags: TraceFlags.SAMPLED,
          },
          attributes: { [ATTR_DSH_PARENT_SESSION]: parentId },
        })
      }
    }
    const rootContext = root.spanContext()
    this.traces.set(journal.id, { traceId: rootContext.traceId, spanId: rootContext.spanId })
    journal.turn = {
      root,
      context: trace.setSpan(ROOT_CONTEXT, root),
      index: turn,
      generations: new Map(),
      tools: new Map(),
    }
  }

  private readonly endTurn: EventHandler = (journal, record) => {
    const open = journal.turn
    if (open === undefined) return
    const { reason } = payload<'turn/end'>(record)
    open.root.setAttribute(ATTR_DSH_TURN_END_REASON, this.serialize(reason))
    if (record.severity === 'error') open.root.setStatus({ code: SpanStatusCode.ERROR })
    this.closeTurn(journal, record.time, false)
  }

  private readonly rememberPrompt: EventHandler = (journal, record) => {
    journal.promptText = plainText(record.body)
    journal.turn?.root.setAttribute(ATTR_LANGFUSE_TRACE_INPUT, this.serialize(record.body))
  }

  private readonly beginGeneration: EventHandler = (journal, record) => {
    const open = journal.turn
    if (open === undefined) return
    const { step } = payload<'step/start'>(record)
    const header = journal.header
    const config = header?.config as { model?: string; provider?: string } | undefined
    const span = this.tracer.startSpan(
      `step ${open.index}.${step}`,
      {
        startTime: record.time,
        attributes: {
          [ATTR_LANGFUSE_OBSERVATION_TYPE]: 'generation',
          [ATTR_DSH_TURN]: open.index,
          [ATTR_DSH_STEP]: step,
          [ATTR_DSH_EVENT_SEQ]: record.attributes['event.seq'],
          ...(config?.model !== undefined ? { [ATTR_GEN_AI_REQUEST_MODEL]: config.model } : {}),
          ...(config?.provider !== undefined
            ? { [ATTR_GEN_AI_PROVIDER_NAME]: config.provider }
            : {}),
        },
      },
      open.context,
    )
    if (this.options.includeGenerationInput) {
      span.setAttribute(
        ATTR_LANGFUSE_OBSERVATION_INPUT,
        this.serialize(this.generationInput(journal)),
      )
    }
    const generation: Generation = { span, context: trace.setSpan(open.context, span) }
    open.generations.set(step, generation)
    open.active = generation
  }

  private readonly endGeneration: EventHandler = (journal, record) => {
    const open = journal.turn
    if (open === undefined) return
    const { step } = payload<'step/end'>(record)
    const generation = open.generations.get(step)
    if (generation === undefined) return
    generation.span.end(record.time)
    open.generations.delete(step)
    if (open.active === generation) open.active = undefined
  }

  private readonly stampFirstChunk: EventHandler = (journal, record) => {
    const open = journal.turn
    if (open === undefined) return
    const { step } = payload<'assistant/chunk'>(record)
    const generation = open.generations.get(step)
    if (generation === undefined || generation.firstChunkAt !== undefined) return
    generation.firstChunkAt = record.time
    generation.span.setAttribute(
      ATTR_LANGFUSE_COMPLETION_START_TIME,
      new Date(record.time).toISOString(),
    )
  }

  private readonly recordGenerationResult: EventHandler = (journal, record) => {
    const open = journal.turn
    if (open === undefined) return
    const { step, message, usage } = payload<'assistant/message'>(record)
    const generation = open.generations.get(step)
    if (generation === undefined) return
    generation.span.setAttribute(ATTR_LANGFUSE_OBSERVATION_OUTPUT, this.serialize(message))
    if (usage !== undefined) {
      generation.span.setAttribute(ATTR_GEN_AI_USAGE_INPUT_TOKENS, usage.inputTokens)
      generation.span.setAttribute(ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, usage.outputTokens)
      if (usage.cacheReadTokens !== undefined) {
        generation.span.setAttribute(ATTR_GEN_AI_USAGE_CACHE_READ_TOKENS, usage.cacheReadTokens)
      }
      if (usage.reasoningTokens !== undefined) {
        generation.span.setAttribute(ATTR_GEN_AI_USAGE_REASONING_TOKENS, usage.reasoningTokens)
      }
    }
  }

  private readonly beginTool: EventHandler = (journal, record) => {
    const open = journal.turn
    if (open === undefined) return
    const { step, callId, name, arguments: args } = payload<'tool/call'>(record)
    // A tool call nests under its requesting step; after a crash window the
    // step may already be closed, in which case the turn root adopts it.
    const parent = open.generations.get(step)?.context ?? open.context
    const span = this.tracer.startSpan(
      `tool ${name}`,
      {
        startTime: record.time,
        attributes: {
          [ATTR_LANGFUSE_OBSERVATION_TYPE]: 'tool',
          [ATTR_GEN_AI_TOOL_NAME]: name,
          [ATTR_GEN_AI_TOOL_CALL_ID]: String(callId),
          [ATTR_LANGFUSE_OBSERVATION_INPUT]: this.serialize(structured(args)),
          [ATTR_DSH_TURN]: open.index,
          [ATTR_DSH_STEP]: step,
          [ATTR_DSH_EVENT_SEQ]: record.attributes['event.seq'],
        },
      },
      parent,
    )
    open.tools.set(String(callId), span)
  }

  private readonly endTool: EventHandler = (journal, record) => {
    const open = journal.turn
    if (open === undefined) return
    const { message } = payload<'tool/result'>(record)
    const first = message.content[0]
    if (first === undefined) return
    const key = String(first.toolCallId)
    const span = open.tools.get(key)
    if (span === undefined) return
    span.setAttribute(ATTR_LANGFUSE_OBSERVATION_OUTPUT, this.serialize(structured(first.content)))
    if (record.severity === 'error') span.setStatus({ code: SpanStatusCode.ERROR })
    span.end(record.time)
    open.tools.delete(key)
  }

  // ── ops records ────────────────────────────────────────────────────────

  private applyOps(record: SessionTelemetryRecord): void {
    const id = String(record.attributes['session.id'])
    const journal = this.journals.get(id)
    if (journal === undefined) return
    switch (record.attributes['telemetry.op']) {
      case 'shutdown': {
        if (journal.turn !== undefined) this.closeTurn(journal, record.time, true)
        this.journals.delete(id)
        return
      }
      case 'agent-error': {
        const open = journal.turn
        if (open === undefined) return
        open.root.addEvent(
          'agent-error',
          { 'error.name': String(record.attributes['error.name'] ?? 'Error') },
          record.time,
        )
        open.root.setStatus({ code: SpanStatusCode.ERROR })
        return
      }
      default:
        // Unknown ops vocabulary carries no foldable structure; dropped.
        return
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private closeTurn(journal: Journal, at: number, forced: boolean): void {
    const open = journal.turn
    if (open === undefined) return
    for (const [, generation] of open.generations) {
      if (forced) generation.span.setAttribute(ATTR_DSH_FORCE_ENDED, true)
      generation.span.end(at)
    }
    for (const [, span] of open.tools) {
      if (forced) span.setAttribute(ATTR_DSH_FORCE_ENDED, true)
      span.end(at)
    }
    if (forced) open.root.setAttribute(ATTR_DSH_FORCE_ENDED, true)
    open.root.end(at)
    journal.turn = undefined
  }

  private generationInput(journal: Journal): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    const header = journal.header
    if (header?.system !== undefined) out.system = header.system
    if (header?.tools !== undefined && header.tools.length > 0) out.tools = header.tools
    const config = header?.config as { model?: string; provider?: string } | undefined
    if (config?.model !== undefined) out.model = config.model
    if (config?.provider !== undefined) out.provider = config.provider
    if (journal.promptText !== undefined) out.prompt = journal.promptText
    return out
  }
}
