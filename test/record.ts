/**
 * Shared record builders for tests: seam-shaped records without a running
 * harness, plus a minimal session-shaped object for coordinator integration.
 */

import type { SessionTelemetryRecord } from '@deepseek-ai/dsh-session-telemetry'

export interface LedgerOptions {
  sessionId?: string
  severity?: 'info' | 'warn' | 'error'
  time?: number
  extra?: Record<string, string | number>
}

export function ledger(
  seq: number,
  type: string,
  data: unknown,
  options: LedgerOptions = {},
): SessionTelemetryRecord {
  return {
    channel: 'ledger',
    time: options.time ?? 0,
    severity: options.severity ?? 'info',
    attributes: {
      'session.id': options.sessionId ?? 'session-1',
      'event.type': type,
      'event.seq': seq,
      ...options.extra,
    },
    body: data,
  }
}

export function ops(
  sessionId: string,
  op: string,
  extra: Record<string, string | number> = {},
): SessionTelemetryRecord {
  return {
    channel: 'ops',
    time: 0,
    severity: 'info',
    attributes: { 'session.id': sessionId, 'telemetry.op': op, ...extra },
    body: { op },
  }
}

/** The fields the seam's coordinator reads off a session during capture. */
export function fakeSession(
  id: string,
  events: SessionEventLike[] = [],
): {
  id: string
  header: Record<string, never>
  events: SessionEventLike[]
  firstLiveSeq: number
} {
  // firstLiveSeq 0: canonical-log replay hands over events with seq > -1, so
  // a dense array indexed by seq replays every entry (seq 0 included).
  return { id, header: {}, events, firstLiveSeq: 0 }
}

export interface SessionEventLike {
  type: string
  seq: number
  time: number
  data: unknown
}

export function sessionEvent(type: string, seq: number, data: unknown, time = 0): SessionEventLike {
  return { type, seq, time, data }
}
