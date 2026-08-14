/**
 * Feedback-score push: maps a dsh `feedback/record` event onto Langfuse's
 * public scores API (`POST /api/public/scores`, v3) as a TEXT score attached
 * to the session's latest turn trace. Deliberately best-effort — a failed
 * score push must never disturb the session it annotates.
 *
 * @module dsh-langfuse/score
 */

import { postJson } from './transport.js'

export interface PushScoreOptions {
  /** Langfuse origin, e.g. `http://langfuse.example.com` (no trailing slash). */
  baseUrl: string
  /** Prebuilt `Authorization` header value. */
  authorization: string
  /** Target trace id (the session's latest turn trace). */
  traceId: string
  /** Score name shown in the Langfuse UI. */
  name: string
  /** The recorded human feedback text. */
  text: string
  timeoutMillis?: number
}

/** Langfuse caps TEXT score values; clip defensively before sending. */
const MAX_TEXT_CHARS = 2000

/**
 * Create a TEXT score on the given trace. Resolves on acceptance (2xx);
 * rejects with the response body otherwise.
 */
export async function pushFeedbackScore(options: PushScoreOptions): Promise<void> {
  const text = options.text.trim().slice(0, MAX_TEXT_CHARS)
  if (text.length === 0) {
    throw new Error('dsh-langfuse: feedback text is empty after normalization')
  }
  const body = Buffer.from(
    JSON.stringify({
      name: options.name,
      value: text,
      dataType: 'TEXT',
      traceId: options.traceId,
      source: 'API',
    }),
  )
  const outcome = await postJson({
    url: `${options.baseUrl}/api/public/scores`,
    headers: { 'content-type': 'application/json', authorization: options.authorization },
    body,
    timeoutMillis: options.timeoutMillis,
  })
  if (outcome.status !== 'success') {
    throw new Error(
      `dsh-langfuse: score push failed: status ${outcome.statusCode ?? 'unknown'}: ${outcome.responseBody ?? String(outcome.error ?? '')}`,
    )
  }
}
