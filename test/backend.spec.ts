import { createServer, type Server } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DshLangfuseBackend, DshLangfuseMode } from '../src/index.js'
import { fakeSession, type SessionEventLike, sessionEvent } from './record.js'

/** Emit through the typed bus with fakes cast to the real shapes. */
function emitSessionEvent(ctx: Context, session: unknown, event: SessionEventLike): void {
  ctx.emit('session/event', session as Session, event as unknown as SessionEvent)
}

interface Captured {
  url?: string
  body: Buffer
}

let server: Server | undefined
let captured: Captured[] = []

async function startMock(): Promise<number> {
  captured = []
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      captured.push({ url: req.url, body: Buffer.concat(chunks) })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(req.url?.includes('/scores') ? '{"id":"score-1"}' : '{}')
    })
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock server did not bind')
  return address.port
}

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server === undefined) {
      resolve()
      return
    }
    server.close(() => resolve())
    server = undefined
  })
})

function makeCtx(): Context {
  const ctx = new Context()
  ctx.provide('sessions', { list: () => [] })
  return ctx
}

function uploadConfig(
  port: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    mode: DshLangfuseMode.FULL,
    exporter: { url: `http://127.0.0.1:${port}/api/public/otel/v1/traces` },
    auth: { publicKey: 'pk', secretKey: 'sk' },
    processor: { scheduledDelayMillis: 5 },
    ...overrides,
  }
}

const traces = () => captured.filter((c) => c.url?.includes('/otel/v1/traces'))
const scores = () => captured.filter((c) => c.url === '/api/public/scores')

describe('DshLangfuseBackend with the real telemetry seam', () => {
  it('captures live session events in FULL mode and exports them on shutdown', async () => {
    const port = await startMock()
    const ctx = makeCtx()
    const backend = new DshLangfuseBackend(ctx, uploadConfig(port))
    const session = fakeSession('session-1')
    emitSessionEvent(ctx, session, sessionEvent('turn/start', 1, { turn: 1 }, 1000))
    emitSessionEvent(ctx, session, sessionEvent('step/start', 2, { turn: 1, step: 0 }, 1010))
    emitSessionEvent(
      ctx,
      session,
      sessionEvent(
        'assistant/message',
        3,
        {
          turn: 1,
          step: 0,
          message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        1020,
      ),
    )
    emitSessionEvent(ctx, session, sessionEvent('step/end', 4, { turn: 1, step: 0 }, 1030))
    emitSessionEvent(
      ctx,
      session,
      sessionEvent('turn/end', 5, { turn: 1, reason: { kind: 'completed' } }, 1040),
    )
    await backend.shutdown()
    expect(traces()).toHaveLength(1)
    const payload = traces()[0]?.body.toString() ?? ''
    expect(payload).toContain('turn 1')
    expect(payload).toContain('hi')
  })

  it('pushes a TEXT score for canonical feedback records in FULL mode', async () => {
    const port = await startMock()
    const ctx = makeCtx()
    const backend = new DshLangfuseBackend(ctx, uploadConfig(port))
    const turn = sessionEvent('turn/start', 0, { turn: 1 }, 1000)
    const end = sessionEvent('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }, 1010)
    const feedback = sessionEvent('feedback/record', 2, { text: '很好' }, 1020)
    const session = fakeSession('session-1', [turn, end, feedback])
    emitSessionEvent(ctx, session, turn)
    emitSessionEvent(ctx, session, end)
    emitSessionEvent(ctx, session, feedback)
    await vi.waitFor(() => expect(scores()).toHaveLength(1), { timeout: 2000 })
    const body = JSON.parse(scores()[0]?.body.toString() ?? '{}') as Record<string, unknown>
    expect(body.name).toBe('user-feedback')
    expect(body.value).toBe('很好')
    expect(body.dataType).toBe('TEXT')
    expect(typeof body.traceId).toBe('string')
    await backend.shutdown()
  })

  it('replays the canonical log and pushes the score on feedback in FEEDBACK_ONLY mode', async () => {
    const port = await startMock()
    const ctx = makeCtx()
    const backend = new DshLangfuseBackend(
      ctx,
      uploadConfig(port, { mode: DshLangfuseMode.FEEDBACK_ONLY }),
    )
    const events = [
      sessionEvent('turn/start', 0, { turn: 1 }, 1000),
      sessionEvent('step/start', 1, { turn: 1, step: 0 }, 1010),
      sessionEvent(
        'assistant/message',
        2,
        {
          turn: 1,
          step: 0,
          message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
        },
        1020,
      ),
      sessionEvent('step/end', 3, { turn: 1, step: 0 }, 1030),
      sessionEvent('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }, 1040),
      sessionEvent('feedback/record', 5, { text: '很好' }, 1050),
    ]
    const session = fakeSession('session-1', events)
    // no live capture happens without feedback
    emitSessionEvent(ctx, session, events[0] as SessionEventLike)
    await vi.waitFor(() => expect(traces()).toHaveLength(0), { timeout: 500 })
    // the canonical feedback event triggers replay through its seq
    emitSessionEvent(ctx, session, events[5] as SessionEventLike)
    await vi.waitFor(() => expect(traces()).toHaveLength(1), { timeout: 2000 })
    const payload = traces()[0]?.body.toString() ?? ''
    expect(payload).toContain('turn 1')
    expect(payload).toContain('hi')
    await vi.waitFor(() => expect(scores()).toHaveLength(1), { timeout: 2000 })
    await backend.shutdown()
  })

  it('constructs nothing and sends nothing in DISABLED mode', async () => {
    await startMock()
    const ctx = makeCtx()
    const backend = new DshLangfuseBackend(ctx, { mode: DshLangfuseMode.DISABLED })
    const session = fakeSession('session-1')
    emitSessionEvent(ctx, session, sessionEvent('turn/start', 1, { turn: 1 }, 1000))
    emitSessionEvent(ctx, session, sessionEvent('feedback/record', 2, { text: 'x' }, 1010))
    await backend.shutdown()
    expect(captured).toHaveLength(0)
  })

  it('fails loud on invalid uploading configurations', async () => {
    const port = await startMock()
    expect(() => {
      const ctx = makeCtx()
      new DshLangfuseBackend(ctx, uploadConfig(port, { exporter: {} }))
    }).toThrow(/exporter.url is required/)
    expect(() => {
      const ctx = makeCtx()
      new DshLangfuseBackend(ctx, uploadConfig(port, { exporter: { url: 'ftp://x/y' } }))
    }).toThrow(/must be http/)
    expect(() => {
      const ctx = makeCtx()
      new DshLangfuseBackend(ctx, uploadConfig(port, { auth: {} }))
    }).toThrow(/auth.publicKey/)
    expect(() => {
      const ctx = makeCtx()
      new DshLangfuseBackend(ctx, uploadConfig(port, { processor: { maxExportBatchSize: 0 } }))
    }).toThrow(/maxExportBatchSize/)
    expect(() => {
      const ctx = makeCtx()
      new DshLangfuseBackend(ctx, uploadConfig(port, { maxAttributeChars: 0 }))
    }).toThrow(/maxAttributeChars/)
    expect(() => {
      const ctx = makeCtx()
      new DshLangfuseBackend(ctx, uploadConfig(port, { shutdownTimeoutMillis: 0 }))
    }).toThrow(/shutdownTimeoutMillis/)
    expect(() => {
      const ctx = makeCtx()
      new DshLangfuseBackend(ctx, uploadConfig(port, { mode: 'NOPE' }))
    }).toThrow(/unknown mode/)
  })
})
