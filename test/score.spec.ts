import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { pushFeedbackScore } from '../src/score.js'

interface Captured {
  url?: string
  body: unknown
}

let server: Server | undefined
const captured: Captured[] = []
let respondStatus = 200

async function startMock(): Promise<number> {
  captured.length = 0
  respondStatus = 200
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      captured.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') })
      res.writeHead(respondStatus, { 'content-type': 'application/json' })
      res.end(respondStatus === 200 ? '{"id":"score-1"}' : '{"message":"nope"}')
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

describe('pushFeedbackScore', () => {
  it('POSTs a TEXT score to /api/public/scores with the trace id', async () => {
    const port = await startMock()
    await pushFeedbackScore({
      baseUrl: `http://127.0.0.1:${port}`,
      authorization: 'Basic xyz',
      traceId: 'trace-1',
      name: 'user-feedback',
      text: '  答案很好  ',
    })
    expect(captured).toHaveLength(1)
    expect(captured[0]?.url).toBe('/api/public/scores')
    expect(captured[0]?.body).toEqual({
      name: 'user-feedback',
      value: '答案很好',
      dataType: 'TEXT',
      traceId: 'trace-1',
      source: 'API',
    })
  })

  it('clips long feedback texts to the Langfuse limit', async () => {
    const port = await startMock()
    await pushFeedbackScore({
      baseUrl: `http://127.0.0.1:${port}`,
      authorization: 'Basic xyz',
      traceId: 'trace-1',
      name: 'user-feedback',
      text: 'x'.repeat(5000),
    })
    const body = captured[0]?.body as { value: string }
    expect(body.value).toHaveLength(2000)
  })

  it('rejects empty feedback texts', async () => {
    const port = await startMock()
    await expect(
      pushFeedbackScore({
        baseUrl: `http://127.0.0.1:${port}`,
        authorization: 'Basic xyz',
        traceId: 'trace-1',
        name: 'user-feedback',
        text: '   ',
      }),
    ).rejects.toThrow(/empty/)
    expect(captured).toHaveLength(0)
  })

  it('rejects non-2xx responses with the body', async () => {
    const port = await startMock()
    respondStatus = 400
    await expect(
      pushFeedbackScore({
        baseUrl: `http://127.0.0.1:${port}`,
        authorization: 'Basic xyz',
        traceId: 'trace-1',
        name: 'user-feedback',
        text: 'ok',
      }),
    ).rejects.toThrow(/status 400/)
  })
})
