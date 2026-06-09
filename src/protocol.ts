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
