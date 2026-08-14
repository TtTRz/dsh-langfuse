/**
 * Minimal HTTP POST transport with one deliberate difference from the OTel
 * SDK's built-in transport: the body always travels as a single write with an
 * explicit `Content-Length` header, never as `Transfer-Encoding: chunked`.
 *
 * Some Langfuse deployments sit behind front gateways that mangle chunked
 * POST bodies; Langfuse's OTLP route then fails the request with
 * `400 Failed to parse OTel JSON Trace` even though the bytes were valid.
 * Sending `Content-Length` sidesteps that gateway bug entirely.
 *
 * @module dsh-langfuse/transport
 */

import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

export interface PostOutcome {
  status: 'success' | 'retryable' | 'failure'
  statusCode?: number
  responseBody?: string
  error?: Error
}

export interface PostOptions {
  /** Full http(s) URL, including path. */
  url: string
  headers: Record<string, string>
  body: Buffer
  timeoutMillis?: number
  maxResponseBytes?: number
}

const DEFAULT_TIMEOUT_MILLIS = 10_000
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024
const RETRYABLE_STATUS = new Set([429, 502, 503, 504])
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
])

/** Langfuse's Basic-auth header value from a project key pair. */
export function basicAuthHeader(publicKey: string, secretKey: string): string {
  return `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`
}

/**
 * POST `body` to `url` with `Content-Length` set explicitly (no chunked
 * transfer). Resolves once the response completes or the request fails;
 * 2xx maps to `success`, 429/502/503/504 and transport-level network errors
 * to `retryable`, everything else to `failure`.
 */
export function postJson(options: PostOptions): Promise<PostOutcome> {
  return new Promise((resolve) => {
    let parsed: URL
    try {
      parsed = new URL(options.url)
    } catch {
      resolve({ status: 'failure', error: new Error(`dsh-langfuse: invalid url: ${options.url}`) })
      return
    }
    const lib =
      parsed.protocol === 'https:'
        ? httpsRequest
        : parsed.protocol === 'http:'
          ? httpRequest
          : undefined
    if (lib === undefined) {
      resolve({
        status: 'failure',
        error: new Error(`dsh-langfuse: unsupported protocol: ${parsed.protocol}`),
      })
      return
    }
    const headers = { ...options.headers, 'content-length': String(options.body.byteLength) }
    const req = lib(parsed, { method: 'POST', headers }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > (options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES)) {
          res.destroy(new Error('dsh-langfuse: response body exceeded size limit'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        const statusCode = res.statusCode ?? 0
        const responseBody = Buffer.concat(chunks).toString('utf8')
        if (statusCode >= 200 && statusCode <= 299) {
          resolve({ status: 'success', statusCode, responseBody })
        } else if (RETRYABLE_STATUS.has(statusCode)) {
          resolve({ status: 'retryable', statusCode, responseBody })
        } else {
          resolve({ status: 'failure', statusCode, responseBody })
        }
      })
      res.on('error', (error) => resolve({ status: 'failure', error }))
    })
    req.setTimeout(options.timeoutMillis ?? DEFAULT_TIMEOUT_MILLIS, () => {
      req.destroy(
        new Error(
          `dsh-langfuse: request timed out after ${options.timeoutMillis ?? DEFAULT_TIMEOUT_MILLIS}ms`,
        ),
      )
    })
    req.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code
      resolve({ status: RETRYABLE_NETWORK_CODES.has(code ?? '') ? 'retryable' : 'failure', error })
    })
    req.end(options.body)
  })
}
