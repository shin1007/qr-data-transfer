export interface ChunkPayload {
  v: 1
  id: string
  i: number  // chunk index (0-based)
  t: number  // total chunks
  d: string  // base64-encoded chunk data
  n?: string // filename (chunk 0 only)
  s?: number // original (uncompressed) file size in bytes (chunk 0 only)
  z?: 1      // gzip-compressed transfer (chunk 0 only)
}

export function isChunkPayload(obj: unknown): obj is ChunkPayload {
  if (typeof obj !== 'object' || obj === null) return false
  const o = obj as Record<string, unknown>
  return (
    o['v'] === 1 &&
    typeof o['id'] === 'string' &&
    typeof o['i'] === 'number' &&
    typeof o['t'] === 'number' &&
    typeof o['d'] === 'string'
  )
}

export interface AckPayload {
  v: 1
  type: 'ack'
  id: string   // transfer ID
  t: number    // total chunks
  rcv: string  // base64-encoded bitmask: bit i = chunk i received
}

export function isAckPayload(obj: unknown): obj is AckPayload {
  if (typeof obj !== 'object' || obj === null) return false
  const o = obj as Record<string, unknown>
  return (
    o['v'] === 1 &&
    o['type'] === 'ack' &&
    typeof o['id'] === 'string' &&
    typeof o['t'] === 'number' &&
    typeof o['rcv'] === 'string'
  )
}

export function buildAckBitmask(received: Iterable<number>, total: number): string {
  const bytes = new Uint8Array(Math.ceil(total / 8))
  for (const idx of received) {
    bytes[idx >> 3] |= 1 << (idx & 7)
  }
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

export function parseAckBitmask(b64: string, total: number): Set<number> {
  const binary = atob(b64)
  const received = new Set<number>()
  for (let i = 0; i < total; i++) {
    if (binary.charCodeAt(i >> 3) & (1 << (i & 7))) received.add(i)
  }
  return received
}

// ── Compact wire format ──────────────────────────────────────────────────────
// UUID (16 bytes) → 22-char base64url (no padding) to save 14 chars vs UUID string
function uuidToCompactId(uuid: string): string {
  const hex = uuid.replace(/-/g, '')
  let binary = ''
  for (let i = 0; i < 16; i++) binary += String.fromCharCode(parseInt(hex.slice(i * 2, i * 2 + 2), 16))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function compactIdToUuid(compact: string): string {
  const padLen = (4 - (compact.length % 4)) % 4
  const b64 = (compact + '='.repeat(padLen)).replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(b64)
  const hex = Array.from(binary).map(c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
}

// Non-first chunk : B|{cid22}|{i}|{t}|{data_b64}
// First chunk (i=0): B|{cid22}|0|{t}|{origsize}|{flags}|{name_uri}|{data_b64}
export function encodeChunk(p: ChunkPayload): string {
  const cid = uuidToCompactId(p.id)
  if (p.i === 0 && p.n !== undefined) {
    const flags = p.z === 1 ? 1 : 0
    return `B|${cid}|0|${p.t}|${p.s ?? 0}|${flags}|${encodeURIComponent(p.n)}|${p.d}`
  }
  return `B|${cid}|${p.i}|${p.t}|${p.d}`
}

export function decodeChunk(raw: string): ChunkPayload | null {
  if (raw.startsWith('B|')) {
    const parts = raw.split('|')
    try {
      const id = compactIdToUuid(parts[1])
      const i = parseInt(parts[2], 10)
      const t = parseInt(parts[3], 10)
      if (isNaN(i) || isNaN(t)) return null
      if (i === 0 && parts.length >= 8) {
        const s = parseInt(parts[4], 10)
        const flags = parseInt(parts[5], 10)
        const n = decodeURIComponent(parts[6])
        const d = parts[7]
        const chunk: ChunkPayload = { v: 1, id, i, t, d, n, s: isNaN(s) ? 0 : s }
        if (flags & 1) chunk.z = 1
        return chunk
      }
      if (parts.length < 5) return null
      return { v: 1, id, i, t, d: parts[4] }
    } catch { return null }
  }
  try {
    const obj = JSON.parse(raw)
    return isChunkPayload(obj) ? obj : null
  } catch { return null }
}

// ACK: A|{cid22}|{t}|{bitmask_b64}
export function encodeAck(p: AckPayload): string {
  return `A|${uuidToCompactId(p.id)}|${p.t}|${p.rcv}`
}

export function decodeAck(raw: string): AckPayload | null {
  if (raw.startsWith('A|')) {
    const parts = raw.split('|')
    if (parts.length < 4) return null
    try {
      const id = compactIdToUuid(parts[1])
      const t = parseInt(parts[2], 10)
      if (isNaN(t)) return null
      return { v: 1, type: 'ack', id, t, rcv: parts[3] }
    } catch { return null }
  }
  try {
    const obj = JSON.parse(raw)
    return isAckPayload(obj) ? obj : null
  } catch { return null }
}
