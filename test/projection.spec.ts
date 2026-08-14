import { SpanStatusCode } from '@opentelemetry/api'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { describe, expect, it } from 'vitest'
import { SessionTimeline, type TimelineOptions, TRUNCATION_MARK } from '../src/projection.js'
import * as semconv from '../src/semconv.js'
import { ledger, ops } from './record.js'

function makeTimeline(options: Partial<TimelineOptions> = {}): {
  folder: SessionTimeline
  spans: () => ReadableSpan[]
} {
  const inMemory = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(inMemory)] })
  const folder = new SessionTimeline(provider.getTracer('test'), {
    maxAttributeChars: 32_768,
    includeGenerationInput: false,
    ...options,
  })
  return { folder, spans: () => inMemory.getFinishedSpans() }
}

function foldHappyTurn(folder: SessionTimeline): void {
  folder.fold(ledger(1, 'turn/start', { turn: 1 }, { time: 1000 }))
  folder.fold(
    ledger(
      2,
      'request/header',
      {
        header: { config: { model: 'm1', provider: 'p1' }, system: 'sys', tools: [{ name: 't1' }] },
        reason: 'initial',
      },
      { time: 1010 },
    ),
  )
  folder.fold(
    ledger(3, 'user/message', { content: [{ type: 'text', text: 'hello' }] }, { time: 1020 }),
  )
  folder.fold(ledger(4, 'step/start', { turn: 1, step: 1 }, { time: 1030 }))
  folder.fold(ledger(5, 'assistant/chunk', { turn: 1, step: 1, chunk: {} }, { time: 1040 }))
  folder.fold(
    ledger(
      6,
      'assistant/message',
      {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 100, reasoningTokens: 2 },
      },
      { time: 1050 },
    ),
  )
  folder.fold(
    ledger(
      7,
      'tool/call',
      { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' },
      { time: 1060 },
    ),
  )
  folder.fold(
    ledger(
      8,
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: { content: [{ toolCallId: 'c1', content: 'out', isError: false }] },
      },
      { time: 1070 },
    ),
  )
  folder.fold(ledger(9, 'step/end', { turn: 1, step: 1 }, { time: 1080 }))
  folder.fold(ledger(10, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, { time: 1090 }))
}

describe('SessionTimeline', () => {
  it('folds a full turn into turn/generation/tool spans with the right attributes', () => {
    const { folder, spans } = makeTimeline()
    foldHappyTurn(folder)
    const finished = spans()
    expect(finished).toHaveLength(3)
    const turn = finished.find((s) => s.name === 'turn 1')
    const step = finished.find((s) => s.name === 'step 1.1')
    const tool = finished.find((s) => s.name === 'tool bash')
    expect(turn).toBeDefined()
    expect(step).toBeDefined()
    expect(tool).toBeDefined()
    expect(turn?.parentSpanContext).toBeUndefined()
    expect(step?.parentSpanContext?.spanId).toBe(turn?.spanContext().spanId)
    expect(tool?.parentSpanContext?.spanId).toBe(step?.spanContext().spanId)
    // turn-level mapping
    expect(turn?.attributes[semconv.ATTR_LANGFUSE_TRACE_NAME]).toBe('turn 1')
    expect(String(turn?.attributes[semconv.ATTR_LANGFUSE_TRACE_INPUT])).toContain('hello')
    // generation mapping
    expect(step?.attributes[semconv.ATTR_LANGFUSE_OBSERVATION_TYPE]).toBe('generation')
    expect(step?.attributes[semconv.ATTR_GEN_AI_REQUEST_MODEL]).toBe('m1')
    expect(step?.attributes[semconv.ATTR_GEN_AI_PROVIDER_NAME]).toBe('p1')
    expect(step?.attributes[semconv.ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBe(10)
    expect(step?.attributes[semconv.ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(3)
    expect(step?.attributes[semconv.ATTR_GEN_AI_USAGE_CACHE_READ_TOKENS]).toBe(100)
    expect(step?.attributes[semconv.ATTR_GEN_AI_USAGE_REASONING_TOKENS]).toBe(2)
    expect(step?.attributes[semconv.ATTR_LANGFUSE_COMPLETION_START_TIME]).toBe(
      new Date(1040).toISOString(),
    )
    expect(String(step?.attributes[semconv.ATTR_LANGFUSE_OBSERVATION_OUTPUT])).toContain('hi')
    // tool mapping
    expect(tool?.attributes[semconv.ATTR_LANGFUSE_OBSERVATION_TYPE]).toBe('tool')
    expect(tool?.attributes[semconv.ATTR_GEN_AI_TOOL_NAME]).toBe('bash')
    expect(tool?.attributes[semconv.ATTR_GEN_AI_TOOL_CALL_ID]).toBe('c1')
    expect(tool?.attributes[semconv.ATTR_LANGFUSE_OBSERVATION_INPUT]).toBe('{"cmd":"ls"}')
    expect(tool?.attributes[semconv.ATTR_LANGFUSE_OBSERVATION_OUTPUT]).toBe('out')
  })

  it('marks error turn endings and failed tool results as ERROR status', () => {
    const { folder, spans } = makeTimeline()
    folder.fold(ledger(1, 'turn/start', { turn: 1 }, { time: 1000 }))
    folder.fold(ledger(2, 'step/start', { turn: 1, step: 1 }, { time: 1010 }))
    folder.fold(
      ledger(
        3,
        'tool/call',
        { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' },
        { time: 1020 },
      ),
    )
    folder.fold(
      ledger(
        4,
        'tool/result',
        {
          turn: 1,
          step: 1,
          message: { content: [{ toolCallId: 'c1', content: 'boom', isError: true }] },
        },
        { time: 1030, severity: 'error' },
      ),
    )
    folder.fold(
      ledger(
        5,
        'turn/end',
        { turn: 1, reason: { kind: 'error', error: { code: 'X', message: 'x' } } },
        {
          time: 1040,
          severity: 'error',
        },
      ),
    )
    const finished = spans()
    const turn = finished.find((s) => s.name === 'turn 1')
    const tool = finished.find((s) => s.name === 'tool bash')
    expect(turn?.status.code).toBe(SpanStatusCode.ERROR)
    expect(tool?.status.code).toBe(SpanStatusCode.ERROR)
    expect(String(turn?.attributes[semconv.ATTR_DSH_TURN_END_REASON])).toContain('error')
  })

  it('keeps only the first assistant/chunk per step as completion_start_time', () => {
    const { folder, spans } = makeTimeline()
    folder.fold(ledger(1, 'turn/start', { turn: 1 }, { time: 1000 }))
    folder.fold(ledger(2, 'step/start', { turn: 1, step: 1 }, { time: 1010 }))
    folder.fold(ledger(3, 'assistant/chunk', { turn: 1, step: 1, chunk: {} }, { time: 1020 }))
    folder.fold(ledger(4, 'assistant/chunk', { turn: 1, step: 1, chunk: {} }, { time: 1030 }))
    folder.fold(ledger(5, 'step/end', { turn: 1, step: 1 }, { time: 1040 }))
    folder.fold(ledger(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, { time: 1050 }))
    const step = spans().find((s) => s.name === 'step 1.1')
    expect(step?.attributes[semconv.ATTR_LANGFUSE_COMPLETION_START_TIME]).toBe(
      new Date(1020).toISOString(),
    )
  })

  it('force-ends an unclosed turn when the next turn starts', () => {
    const { folder, spans } = makeTimeline()
    folder.fold(ledger(1, 'turn/start', { turn: 1 }, { time: 1000 }))
    folder.fold(ledger(2, 'step/start', { turn: 1, step: 1 }, { time: 1010 }))
    folder.fold(ledger(3, 'turn/start', { turn: 2 }, { time: 2000 }))
    const finished = spans()
    const turn1 = finished.find((s) => s.name === 'turn 1')
    const step1 = finished.find((s) => s.name === 'step 1.1')
    expect(turn1?.attributes[semconv.ATTR_DSH_FORCE_ENDED]).toBe(true)
    expect(step1?.attributes[semconv.ATTR_DSH_FORCE_ENDED]).toBe(true)
  })

  it('lands unknown event types as span events on the open turn', () => {
    const { folder, spans } = makeTimeline()
    folder.fold(ledger(1, 'turn/start', { turn: 1 }, { time: 1000 }))
    folder.fold(ledger(2, 'todo/write', { todos: [{ text: 'x' }] }, { time: 1010 }))
    folder.fold(ledger(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, { time: 1020 }))
    const turn = spans().find((s) => s.name === 'turn 1')
    const event = turn?.events.find((e) => e.name === 'todo/write')
    expect(event).toBeDefined()
    expect(event?.attributes?.[semconv.ATTR_DSH_EVENT_SEQ]).toBe(2)
  })

  it('sweeps open spans on the ops shutdown record', () => {
    const { folder, spans } = makeTimeline()
    folder.fold(ledger(1, 'turn/start', { turn: 1 }, { time: 1000 }))
    folder.fold(ledger(2, 'step/start', { turn: 1, step: 1 }, { time: 1010 }))
    folder.fold(ops('session-1', 'shutdown', {}))
    const finished = spans()
    const turn = finished.find((s) => s.name === 'turn 1')
    const step = finished.find((s) => s.name === 'step 1.1')
    expect(turn?.attributes[semconv.ATTR_DSH_FORCE_ENDED]).toBe(true)
    expect(step?.attributes[semconv.ATTR_DSH_FORCE_ENDED]).toBe(true)
  })

  it('marks the open turn ERROR on an agent-error ops record', () => {
    const { folder, spans } = makeTimeline()
    folder.fold(ledger(1, 'turn/start', { turn: 1 }, { time: 1000 }))
    folder.fold(ops('session-1', 'agent-error', { 'error.name': 'Boom' }))
    folder.fold(
      ledger(
        2,
        'turn/end',
        { turn: 1, reason: { kind: 'error' } },
        { time: 1010, severity: 'error' },
      ),
    )
    const turn = spans().find((s) => s.name === 'turn 1')
    expect(turn?.status.code).toBe(SpanStatusCode.ERROR)
    expect(turn?.events.some((e) => e.name === 'agent-error')).toBe(true)
  })

  it('links a child session turn trace to the parent session trace', () => {
    const { folder, spans } = makeTimeline()
    folder.fold(ledger(1, 'turn/start', { turn: 1 }, { sessionId: 'parent', time: 1000 }))
    folder.fold(
      ledger(
        2,
        'turn/end',
        { turn: 1, reason: { kind: 'completed' } },
        { sessionId: 'parent', time: 1010 },
      ),
    )
    folder.fold(
      ledger(
        1,
        'turn/start',
        { turn: 1 },
        {
          sessionId: 'child',
          time: 2000,
          extra: { 'session.parent_id': 'parent' },
        },
      ),
    )
    folder.fold(
      ledger(
        2,
        'turn/end',
        { turn: 1, reason: { kind: 'completed' } },
        { sessionId: 'child', time: 2010 },
      ),
    )
    const finished = spans()
    const parent = finished.find(
      (s) => s.name === 'turn 1' && s.attributes['langfuse.session.id'] === 'parent',
    )
    const child = finished.find(
      (s) => s.name === 'turn 1' && s.attributes['langfuse.session.id'] === 'child',
    )
    expect(parent).toBeDefined()
    expect(child).toBeDefined()
    expect(child?.links).toHaveLength(1)
    expect(child?.links[0]?.context.traceId).toBe(parent?.spanContext().traceId)
    expect(folder.traceIdFor('child')).toBe(child?.spanContext().traceId)
    expect(folder.traceIdFor('parent')).toBe(parent?.spanContext().traceId)
  })

  it('exports generation input only when includeGenerationInput is on', () => {
    const off = makeTimeline()
    off.folder.fold(ledger(1, 'turn/start', { turn: 1 }, { time: 1000 }))
    off.folder.fold(
      ledger(
        2,
        'request/header',
        { header: { config: { model: 'm1', provider: 'p1' }, system: 'sys' }, reason: 'initial' },
        { time: 1010 },
      ),
    )
    off.folder.fold(
      ledger(3, 'user/message', { content: [{ type: 'text', text: 'hello' }] }, { time: 1020 }),
    )
    off.folder.fold(ledger(4, 'step/start', { turn: 1, step: 1 }, { time: 1030 }))
    off.folder.fold(ledger(5, 'step/end', { turn: 1, step: 1 }, { time: 1040 }))
    off.folder.fold(
      ledger(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, { time: 1050 }),
    )
    const offStep = off.spans().find((s) => s.name === 'step 1.1')
    expect(offStep?.attributes[semconv.ATTR_LANGFUSE_OBSERVATION_INPUT]).toBeUndefined()

    const on = makeTimeline({ includeGenerationInput: true })
    on.folder.fold(ledger(1, 'turn/start', { turn: 1 }, { time: 1000 }))
    on.folder.fold(
      ledger(
        2,
        'request/header',
        { header: { config: { model: 'm1', provider: 'p1' }, system: 'sys' }, reason: 'initial' },
        { time: 1010 },
      ),
    )
    on.folder.fold(
      ledger(3, 'user/message', { content: [{ type: 'text', text: 'hello' }] }, { time: 1020 }),
    )
    on.folder.fold(ledger(4, 'step/start', { turn: 1, step: 1 }, { time: 1030 }))
    on.folder.fold(ledger(5, 'step/end', { turn: 1, step: 1 }, { time: 1040 }))
    on.folder.fold(
      ledger(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, { time: 1050 }),
    )
    const onStep = on.spans().find((s) => s.name === 'step 1.1')
    const input = String(onStep?.attributes[semconv.ATTR_LANGFUSE_OBSERVATION_INPUT])
    expect(input).toContain('sys')
    expect(input).toContain('hello')
    expect(input).toContain('m1')
  })

  it('falls back to the turn span when a tool call arrives after its step closed', () => {
    const { folder, spans } = makeTimeline()
    folder.fold(ledger(1, 'turn/start', { turn: 1 }, { time: 1000 }))
    folder.fold(ledger(2, 'step/start', { turn: 1, step: 1 }, { time: 1010 }))
    folder.fold(ledger(3, 'step/end', { turn: 1, step: 1 }, { time: 1020 }))
    folder.fold(
      ledger(
        4,
        'tool/call',
        { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' },
        { time: 1030 },
      ),
    )
    folder.fold(
      ledger(
        5,
        'tool/result',
        {
          turn: 1,
          step: 1,
          message: { content: [{ toolCallId: 'c1', content: 'out', isError: false }] },
        },
        { time: 1040 },
      ),
    )
    folder.fold(ledger(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, { time: 1050 }))
    const finished = spans()
    const turn = finished.find((s) => s.name === 'turn 1')
    const tool = finished.find((s) => s.name === 'tool bash')
    expect(tool?.parentSpanContext?.spanId).toBe(turn?.spanContext().spanId)
  })

  it('clips oversized payloads with a marker', () => {
    const { folder, spans } = makeTimeline({ maxAttributeChars: 10 })
    folder.fold(ledger(1, 'turn/start', { turn: 1 }, { time: 1000 }))
    folder.fold(ledger(2, 'step/start', { turn: 1, step: 1 }, { time: 1010 }))
    folder.fold(
      ledger(
        3,
        'assistant/message',
        {
          turn: 1,
          step: 1,
          message: { role: 'assistant', content: [{ type: 'text', text: 'a very long output' }] },
        },
        { time: 1020 },
      ),
    )
    folder.fold(ledger(4, 'step/end', { turn: 1, step: 1 }, { time: 1030 }))
    folder.fold(ledger(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, { time: 1040 }))
    const step = spans().find((s) => s.name === 'step 1.1')
    const output = String(step?.attributes[semconv.ATTR_LANGFUSE_OBSERVATION_OUTPUT])
    expect(output.endsWith(TRUNCATION_MARK)).toBe(true)
  })
})
