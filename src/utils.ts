export function formatTransferTime(seconds: number): string {
  if (seconds < 60) return `約${Math.ceil(seconds)}秒`
  const minutes = seconds / 60
  if (minutes < 60) return `約${Math.ceil(minutes)}分`
  const hours = Math.floor(minutes / 60)
  const remainMinutes = Math.ceil(minutes % 60)
  return remainMinutes > 0 ? `約${hours}時間${remainMinutes}分` : `約${hours}時間`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatEta(seconds: number): string {
  if (seconds < 5) return '残り数秒'
  if (seconds < 60) return `残り約${Math.round(seconds)}秒`
  return `残り約${Math.ceil(seconds / 60)}分`
}

// Sliding-window ETA: uses only the last 8 seconds of samples to compute rate.
// Returns null until the window is stable enough to give a reliable estimate.
export function computeEta(
  current: number,
  total: number,
  samples: Array<{t: number, n: number}>,
): string | null {
  const now = Date.now()
  samples.push({t: now, n: current})

  const cutoff = now - 8000
  while (samples.length > 1 && samples[0].t < cutoff) samples.shift()

  if (samples.length < 2) return null

  const oldest = samples[0]
  const elapsed = (now - oldest.t) / 1000
  if (elapsed < 1.5) return null

  const deltaChunks = current - oldest.n
  if (deltaChunks <= 0) return null

  const rate = deltaChunks / elapsed
  const remaining = (total - current) / rate
  if (remaining <= 0) return null

  return formatEta(remaining)
}
