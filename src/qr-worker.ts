import jsQR from 'jsqr'

type WorkerCtx = {
  onmessage: ((e: MessageEvent) => void) | null
  postMessage(data: unknown): void
}

const ctx = self as unknown as WorkerCtx

ctx.onmessage = (e: MessageEvent<{ data: Uint8ClampedArray; width: number; height: number }>) => {
  const { data, width, height } = e.data
  const code = jsQR(data, width, height, { inversionAttempts: 'dontInvert' })
  ctx.postMessage(code?.data ?? null)
}
