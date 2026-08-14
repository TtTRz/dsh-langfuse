import { createServer, type Server } from 'node:http'
import { ExportResultCode } from '@opentelemetry/core'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { afterEach, describe, expect, it } from 'vitest'
import { ContentLengthSpanExporter } from '../src/exporter.js'

interface Captured {
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

let server: Server | undefined
const captured: Captured[] = []
let respondStatus = 200
let respondDelayMillis = 0

async function startMock(): Promise<number> {
  captured.length = 0
  respondStatus = 200
  respondDelayMillis = 0
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      captured.push({ headers: req.headers, body: Buffer.concat(chunks) })
      setTimeout(() => {
        res.writeHead(respondStatus, { 'content-type': 'application/json' })
        res.end(respondStatus === 200 ? '{}' : '{"error":"mock"}')
      }, respondDelayMillis)
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

function makeSpans(): ReadableSpan[] {
  const inMemory = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(inMemory)] })
  const tracer = provider.getTracer('t')
  const span = tracer.startSpan('probe', { attributes: { num: 1, str: 'v' } })
  span.end(Date.now())
  return inMemory.getFinishedSpans()
}

describe('ContentLengthSpanExporter', () => {
  it('serializes OTLP/JSON with hex ids and numeric intValue, sent with Content-Length', async () => {
    const port = await startMock()
    const exporter = new ContentLengthSpanExporter({
      url: `http://127.0.0.1:${port}/api/public/otel/v1/traces`,
      authorization: 'Basic xyz',
    })
    const result = await new Promise<boolean>((resolve) => {
      exporter.export(makeSpans(), (r) => resolve(r.code === ExportResultCode.SUCCESS))
    })
    expect(result).toBe(true)
    expect(captured).toHaveLength(1)
    const request = captured[0]
    expect(request?.headers['content-type']).toBe('application/json')
    expect(request?.headers['content-length']).toBe(String(request?.body.byteLength))
    expect(request?.headers['transfer-encoding']).toBeUndefined()
    const json = JSON.parse(request?.body.toString() ?? '') as {
      resourceSpans: Array<{
        scopeSpans: Array<{
          spans: Array<{
            traceId: string
            spanId: string
            attributes: Array<{ key: string; value: { intValue?: number } }>
          }>
        }>
      }>
    }
    const span = json.resourceSpans[0]?.scopeSpans[0]?.spans[0]
    expect(span?.traceId).toMatch(/^[0-9a-f]{32}$/)
    expect(span?.spanId).toMatch(/^[0-9a-f]{16}$/)
    const num = span?.attributes.find((a) => a.key === 'num')
    expect(num?.value.intValue).toBe(1)
  })

  it('retries on retryable statuses before succeeding', async () => {
    const port = await startMock()
    respondStatus = 503
    const exporter = new ContentLengthSpanExporter({
      url: `http://127.0.0.1:${port}/api/public/otel/v1/traces`,
      backoffMillis: [5, 5, 5],
      maxAttempts: 4,
    })
    const first = await new Promise<boolean>((resolve) => {
      exporter.export(makeSpans(), (r) => resolve(r.code === ExportResultCode.SUCCESS))
    })
    // the exporter retried 503 up to maxAttempts before giving up
    expect(first).toBe(false)
    expect(captured).toHaveLength(4)
    // a healthy server on the next export succeeds
    respondStatus = 200
    const second = await new Promise<boolean>((resolve) => {
      exporter.export(makeSpans(), (r) => resolve(r.code === ExportResultCode.SUCCESS))
    })
    expect(second).toBe(true)
    expect(captured).toHaveLength(5)
  })

  it('does not retry a 400 failure', async () => {
    const port = await startMock()
    respondStatus = 400
    const exporter = new ContentLengthSpanExporter({
      url: `http://127.0.0.1:${port}/api/public/otel/v1/traces`,
      backoffMillis: [5, 5],
      maxAttempts: 3,
    })
    const result = await new Promise<boolean>((resolve) => {
      exporter.export(makeSpans(), (r) => resolve(r.code === ExportResultCode.SUCCESS))
    })
    expect(result).toBe(false)
    expect(captured).toHaveLength(1)
  })

  it('stops new exports after shutdown and waits for in-flight requests', async () => {
    const port = await startMock()
    respondDelayMillis = 150
    const exporter = new ContentLengthSpanExporter({
      url: `http://127.0.0.1:${port}/api/public/otel/v1/traces`,
    })
    let first = false
    exporter.export(makeSpans(), (r) => {
      first = r.code === ExportResultCode.SUCCESS
    })
    const startedAt = Date.now()
    await exporter.shutdown()
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100)
    expect(first).toBe(true)
    expect(captured).toHaveLength(1)
    // after shutdown, exports resolve success without any request
    const result = await new Promise<boolean>((resolve) => {
      exporter.export(makeSpans(), (r) => resolve(r.code === ExportResultCode.SUCCESS))
    })
    expect(result).toBe(true)
    expect(captured).toHaveLength(1)
  })
})
