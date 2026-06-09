// Extensions that are already compressed — gzip would be wasteful
const SKIP_EXTENSIONS = new Set([
  // Compressed images
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif', 'avif',
  // Video (all major formats are compressed)
  'mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'flv',
  // Compressed audio (note: wav/aiff are PCM — compressible)
  'mp3', 'aac', 'ogg', 'flac', 'm4a', 'opus',
  // Archives
  'zip', 'gz', 'bz2', '7z', 'rar', 'xz', 'zst',
  // Documents stored as ZIP internally
  'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp',
  // Other
  'pdf', 'apk', 'ipa', 'wasm',
])

const SKIP_MIME_PREFIXES = ['image/', 'video/', 'audio/']
const SKIP_MIME_TYPES = new Set([
  'application/zip',
  'application/gzip',
  'application/x-7z-compressed',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
])

export function shouldCompress(file: File): boolean {
  // Tiny files: gzip header overhead (~18B) not worth it
  if (file.size < 512) return false

  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (ext && SKIP_EXTENSIONS.has(ext)) return false

  const mime = file.type
  if (mime) {
    if (SKIP_MIME_PREFIXES.some(p => mime.startsWith(p))) return false
    if (SKIP_MIME_TYPES.has(mime)) return false
  }

  return true
}

export async function compressBuffer(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const stream = new Blob([buffer]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Response(stream).arrayBuffer()
}

export async function decompressBuffer(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).arrayBuffer()
}
