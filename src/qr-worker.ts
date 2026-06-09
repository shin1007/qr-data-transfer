import jsQR from 'jsqr'

type WorkerCtx = {
  onmessage: ((e: MessageEvent) => void) | null
  postMessage(data: unknown): void
}

const ctx = self as unknown as WorkerCtx

const utf8Decoder = new TextDecoder('utf-8')

ctx.onmessage = (e: MessageEvent<{ data: Uint8ClampedArray; width: number; height: number }>) => {
  const { data, width, height } = e.data
  const code = jsQR(data, width, height, { inversionAttempts: 'attemptBoth' })
  if (!code) {
    ctx.postMessage(null)
    return
  }
  // jsQR returns byte-mode QR data as a Latin-1 string (one char per byte).
  // Re-decode those raw bytes as UTF-8 to restore multi-byte characters correctly.
  const bytes = new Uint8Array(code.data.length)
  for (let i = 0; i < code.data.length; i++) {
    bytes[i] = code.data.charCodeAt(i) & 0xff
  }
  ctx.postMessage(utf8Decoder.decode(bytes))
}
