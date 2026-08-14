import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { basicAuthHeader, postJson } from '../src/transport.js'

interface Captured {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  body: Buffer
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
      captured.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks),
      })
      res.writeHead(respondStatus, { 'content-type': 'application/json' })
      res.end(respondStatus === 200 ? '{}' : '{"error":"mock"}')
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

describe('basicAuthHeader', () => {
  it('builds Langfuse Basic auth from the project key pair', () => {
    expect(basicAuthHeader('pk', 'sk')).toBe(`Basic ${Buffer.from('pk:sk').toString('base64')}`)
  })
})

describe('postJson', () => {
  it('sends a single write with explicit Content-Length and no chunked encoding', async () => {
    const port = await startMock()
    const body = Buffer.from('{"hello":"world"}')
    const outcome = await postJson({
      url: `http://127.0.0.1:${port}/api/public/otel/v1/traces`,
      headers: { 'content-type': 'application/json', authorization: 'Basic xyz' },
      body,
    })
    expect(outcome.status).toBe('success')
    expect(captured).toHaveLength(1)
    const request = captured[0]
    expect(request?.headers['content-length']).toBe(String(body.byteLength))
    expect(request?.headers['transfer-encoding']).toBeUndefined()
    expect(request?.headers['content-type']).toBe('application/json')
    expect(request?.body.toString()).toBe('{"hello":"world"}')
  })

  it('maps 400 to failure', async () => {
    const port = await startMock()
    respondStatus = 400
    const outcome = await postJson({
      url: `http://127.0.0.1:${port}/x`,
      headers: {},
      body: Buffer.from('x'),
    })
    expect(outcome.status).toBe('failure')
    expect(outcome.statusCode).toBe(400)
  })

  it('maps 503 to retryable', async () => {
    const port = await startMock()
    respondStatus = 503
    const outcome = await postJson({
      url: `http://127.0.0.1:${port}/x`,
      headers: {},
      body: Buffer.from('x'),
    })
    expect(outcome.status).toBe('retryable')
  })

  it('rejects malformed urls and unsupported protocols as failures', async () => {
    await expect(
      postJson({ url: 'not-a-url', headers: {}, body: Buffer.from('x') }),
    ).resolves.toMatchObject({
      status: 'failure',
    })
    await expect(
      postJson({ url: 'ftp://x/y', headers: {}, body: Buffer.from('x') }),
    ).resolves.toMatchObject({
      status: 'failure',
    })
  })

  it('maps refused connections to retryable', async () => {
    const outcome = await postJson({
      url: 'http://127.0.0.1:1/x',
      headers: {},
      body: Buffer.from('x'),
      timeoutMillis: 500,
    })
    expect(outcome.status).toBe('retryable')
  })
})
