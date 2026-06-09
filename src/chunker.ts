import type { ChunkPayload } from './protocol'

export const DEFAULT_CHUNK_SIZE = 400

export function splitBuffer(
  buffer: ArrayBuffer,
  filename: string,
  transferId: string,
  chunkSize = DEFAULT_CHUNK_SIZE,
  originalSize?: number,
  compressed?: boolean,
): ChunkPayload[] {
  const bytes = new Uint8Array(buffer)
  const total = Math.max(1, Math.ceil(bytes.length / chunkSize))
  const chunks: ChunkPayload[] = []

  for (let i = 0; i < total; i++) {
    const slice = bytes.slice(i * chunkSize, (i + 1) * chunkSize)
    const chunk: ChunkPayload = {
      v: 1,
      id: transferId,
      i,
      t: total,
      d: uint8ToBase64(slice),
    }
    if (i === 0) {
      chunk.n = filename
      chunk.s = originalSize ?? buffer.byteLength
      if (compressed) chunk.z = 1
    }
    chunks.push(chunk)
  }

  return chunks
}

export function reassembleChunks(
  received: Map<number, ChunkPayload>,
  total: number,
): Uint8Array {
  const parts: Uint8Array[] = []
  for (let i = 0; i < total; i++) {
    const chunk = received.get(i)
    if (!chunk) throw new Error(`Missing chunk ${i}`)
    parts.push(base64ToUint8(chunk.d))
  }

  const totalLen = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(totalLen)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
