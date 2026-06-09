import QRCode from 'qrcode'
import { splitBuffer } from './chunker'
import { decodeAck, encodeChunk, parseAckBitmask } from './protocol'
import type { ChunkPayload } from './protocol'
import { formatBytes, computeEta, formatTransferTime } from './utils'
import { shouldCompress, compressBuffer } from './compressor'

export class SenderView {
  private container: HTMLElement

  // Transfer state
  private chunks: ChunkPayload[] = []
  private pendingIndices: number[] = []
  private pendingPos = 0
  private interval: number | null = null
  private fps = 1
  private rendering = false
  private done = false

  // File storage for re-splitting
  private transferBuffer: ArrayBuffer | null = null
  private transferFile: File | null = null
  private compressedSize: number | null = null

  // Chunk size control
  private chunkSize = 200
  private autoChunkSize = true
  private chunkSizeLastChange = 0

  // ACK camera state
  private ackedChunks = new Set<number>()
  private ackStream: MediaStream | null = null
  private ackAnimFrame = 0
  private ackVideo!: HTMLVideoElement
  private ackScanCanvas!: HTMLCanvasElement
  private ackScanCtx!: CanvasRenderingContext2D
  private lastAckData = ''
  private lastAckScanTime = 0
  private ackEtaSamples: Array<{t: number, n: number}> = []

  // Web Worker for jsQR decoding
  private scanWorker: Worker
  private workerBusy = false

  // Adaptive fps
  private autoFps = true
  private ackFacingMode: 'user' | 'environment' = 'user'

  // Pre-render double-buffer (#2)
  private nextBitmap: ImageBitmap | null = null
  private nextBitmapForIndex = -1
  private preparingBitmap = false

  constructor(container: HTMLElement) {
    this.container = container
    this.scanWorker = new Worker(new URL('./qr-worker.ts', import.meta.url), { type: 'module' })
    this.scanWorker.onmessage = (e: MessageEvent<string | null>) => {
      this.workerBusy = false
      const data = e.data
      if (data && data !== this.lastAckData) {
        this.lastAckData = data
        this.processAckData(data)
      }
    }
    this.render()
  }

  private render() {
    this.container.innerHTML = `
      <div class="view">
        <label class="drop-zone" id="drop-zone">
          <input type="file" id="file-input">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round"
              d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"/>
          </svg>
          <p>ここにファイルをドロップ<br><span>またはクリックして選択</span></p>
        </label>
        <p class="size-hint">推奨: 200KB以下（大きいほど時間がかかります）</p>

        <div class="qr-area hidden" id="qr-area">
          <div class="qr-wrapper">
            <canvas id="qr-canvas"></canvas>
          </div>
          <div class="transfer-info">
            <p id="chunk-counter" class="counter">0 / 0</p>
            <div class="progress-bar"><div id="progress-fill" style="width:0%"></div></div>
            <p id="ack-info" class="file-info"></p>
            <p id="eta-display" class="eta hidden"></p>
            <p id="file-info" class="file-info"></p>
            <p id="transfer-estimate" class="transfer-estimate hidden"></p>
          </div>

          <div class="ack-scan-section" id="ack-scan-section">
            <p class="section-label">受信確認QRをスキャン中</p>
            <div class="mini-video-wrapper">
              <video id="ack-video" autoplay playsinline muted></video>
              <canvas id="ack-scan-canvas" hidden></canvas>
            </div>
            <div style="display:flex;align-items:center;gap:0.5rem;margin-top:0.5rem">
              <p id="ack-camera-status" class="ack-status" style="flex:1;margin:0">カメラ起動中...</p>
              <button class="btn-ghost" id="switch-ack-camera-btn" style="padding:0.25rem 0.6rem;font-size:0.8rem">⇄</button>
            </div>
          </div>

          <div class="controls">
            <button class="btn-secondary" id="play-pause-btn">⏸ 一時停止</button>
            <button class="btn-ghost" id="reset-btn">✕ リセット</button>
          </div>
          <div class="speed-control">
            <div class="speed-header">
              <span class="speed-label">速度: <strong id="fps-display">${this.fps}</strong> fps</span>
              <button class="btn-auto active" id="auto-fps-btn">自動</button>
            </div>
            <input type="range" id="fps-slider" min="1" max="15" value="${this.fps}" disabled>
          </div>
          <div class="speed-control">
            <div class="speed-header">
              <span class="speed-label">チャンク: <strong id="chunk-size-display">${this.chunkSize}</strong> B</span>
              <button class="btn-auto active" id="auto-chunk-btn">自動</button>
            </div>
            <input type="range" id="chunk-size-slider" min="100" max="1000" step="50" value="${this.chunkSize}" disabled>
          </div>
        </div>
      </div>
    `
    this.setupEvents()
  }

  private setupEvents() {
    const fileInput = this.container.querySelector<HTMLInputElement>('#file-input')!
    const dropZone = this.container.querySelector<HTMLElement>('#drop-zone')!

    fileInput.addEventListener('change', () => {
      if (fileInput.files?.[0]) void this.loadFile(fileInput.files[0])
    })

    dropZone.addEventListener('dragover', e => {
      e.preventDefault()
      dropZone.classList.add('drag-over')
    })
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
    dropZone.addEventListener('drop', e => {
      e.preventDefault()
      dropZone.classList.remove('drag-over')
      const f = e.dataTransfer?.files[0]
      if (f) void this.loadFile(f)
    })

    this.container.querySelector('#play-pause-btn')?.addEventListener('click', () => this.togglePlay())
    this.container.querySelector('#reset-btn')?.addEventListener('click', () => this.reset())

    const fpsSlider = this.container.querySelector<HTMLInputElement>('#fps-slider')!
    fpsSlider.addEventListener('input', () => {
      this.fps = parseInt(fpsSlider.value)
      this.updateFpsDisplay()
      this.updateTransferEstimate()
      if (this.interval !== null) {
        this.stopAnimation()
        this.startAnimation()
      }
    })

    this.container.querySelector('#auto-fps-btn')?.addEventListener('click', () => {
      this.autoFps = !this.autoFps
      const btn = this.container.querySelector('#auto-fps-btn')!
      btn.classList.toggle('active', this.autoFps)
      fpsSlider.disabled = this.autoFps
      if (!this.autoFps) {
        this.fps = parseInt(fpsSlider.value)
        this.updateFpsDisplay()
        this.updateTransferEstimate()
      }
    })

    const chunkSlider = this.container.querySelector<HTMLInputElement>('#chunk-size-slider')!
    chunkSlider.addEventListener('change', () => {
      const newSize = parseInt(chunkSlider.value)
      if (newSize !== this.chunkSize) {
        this.autoChunkSize = false
        this.container.querySelector('#auto-chunk-btn')!.classList.remove('active')
        void this.applyChunkSizeChange(newSize)
      }
    })

    this.container.querySelector('#auto-chunk-btn')?.addEventListener('click', () => {
      this.autoChunkSize = !this.autoChunkSize
      const btn = this.container.querySelector('#auto-chunk-btn')!
      btn.classList.toggle('active', this.autoChunkSize)
      chunkSlider.disabled = this.autoChunkSize
    })
  }

  private async loadFile(file: File) {
    const MAX_BYTES = 5 * 1024 * 1024
    const WARN_BYTES = 200 * 1024
    const hint = this.container.querySelector('.size-hint')!

    if (file.size > MAX_BYTES) {
      hint.textContent = `ファイルが大きすぎます (${formatBytes(file.size)})。5MB 以下のファイルを選択してください。`
      hint.classList.add('size-hint-error')
      return
    }
    hint.classList.remove('size-hint-error')

    const originalBuffer = await file.arrayBuffer()
    let transferBuffer = originalBuffer
    let compressedSize: number | null = null

    if (shouldCompress(file)) {
      hint.textContent = '圧縮中...'
      const compressed = await compressBuffer(originalBuffer)
      if (compressed.byteLength < originalBuffer.byteLength * 0.95) {
        transferBuffer = compressed
        compressedSize = compressed.byteLength
      }
    }

    if (compressedSize === null) {
      if (file.size > WARN_BYTES) {
        hint.textContent = `${formatBytes(file.size)} — 転送に時間がかかる場合があります`
      } else {
        hint.textContent = '推奨: 200KB以下（大きいほど時間がかかります）'
      }
    }

    // Store for re-splitting
    this.transferBuffer = transferBuffer
    this.transferFile = file
    this.compressedSize = compressedSize

    this.startTransfer()
  }

  private startTransfer() {
    if (!this.transferBuffer || !this.transferFile) return

    const file = this.transferFile
    const transferBuffer = this.transferBuffer
    const compressedSize = this.compressedSize

    // Enforce minimum chunk size so the ACK bitmask always fits within QR v40 ECL-L (≤16000 chunks)
    const minChunkForQr = Math.ceil(transferBuffer.byteLength / 16000)
    if (minChunkForQr > this.chunkSize) {
      this.chunkSize = minChunkForQr
      this.updateChunkSizeDisplay()
      const slider = this.container.querySelector<HTMLInputElement>('#chunk-size-slider')
      if (slider) slider.value = String(this.chunkSize)
    }

    const id = crypto.randomUUID()
    this.chunks = splitBuffer(
      transferBuffer,
      file.name,
      id,
      this.chunkSize,
      file.size,
      compressedSize !== null,
    )

    this.done = false
    this.ackedChunks = new Set<number>()
    this.pendingIndices = Array.from({ length: this.chunks.length }, (_, i) => i)
    this.pendingPos = 0
    this.lastAckData = ''
    this.lastAckScanTime = 0
    this.ackEtaSamples = []
    this.clearPreRender()

    this.container.querySelector('#drop-zone')!.classList.add('hidden')
    this.container.querySelector('.size-hint')!.classList.add('hidden')
    this.container.querySelector('#qr-area')!.classList.remove('hidden')

    const sizeStr = compressedSize !== null
      ? `${formatBytes(file.size)} → ${formatBytes(compressedSize)} (-${Math.round((1 - compressedSize / file.size) * 100)}%)`
      : formatBytes(file.size)
    this.container.querySelector('#file-info')!.textContent =
      `${file.name}  •  ${sizeStr}  •  ${this.chunks.length} チャンク (${this.chunkSize} B)`

    this.container.querySelector('#ack-info')!.textContent = '受信確認待機中...'
    this.updateTransferEstimate()
    this.updateChunkSizeDisplay()

    if (!this.ackStream) void this.startAckCamera()
    this.startAnimation()
  }

  private async applyChunkSizeChange(newSize: number) {
    if (!this.transferBuffer || !this.transferFile) return
    const minChunkForQr = Math.ceil(this.transferBuffer.byteLength / 16000)
    this.chunkSize = Math.max(newSize, minChunkForQr)
    this.chunkSizeLastChange = Date.now()
    this.stopAnimation()
    this.done = false
    this.startTransfer()
  }

  private startAnimation() {
    this.rebuildPending()
    void this.renderChunk(this.pendingIndices[this.pendingPos] ?? 0)
    this.interval = window.setInterval(() => {
      if (this.pendingIndices.length === 0) return
      this.pendingPos = (this.pendingPos + 1) % this.pendingIndices.length
      void this.renderChunk(this.pendingIndices[this.pendingPos])
    }, 1000 / this.fps)
    this.container.querySelector('#play-pause-btn')!.textContent = '⏸ 一時停止'
  }

  private stopAnimation() {
    if (this.interval !== null) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  private togglePlay() {
    if (this.interval !== null) {
      this.stopAnimation()
      this.container.querySelector('#play-pause-btn')!.textContent = '▶ 再生'
    } else {
      this.startAnimation()
    }
  }

  private reset() {
    this.stopAnimation()
    this.stopAckCamera()
    this.chunks = []
    this.pendingIndices = []
    this.pendingPos = 0
    this.done = false
    this.ackedChunks = new Set<number>()
    this.ackEtaSamples = []
    this.lastAckData = ''
    this.transferBuffer = null
    this.transferFile = null
    this.compressedSize = null
    this.clearPreRender()
    this.container.querySelector('#qr-area')!.classList.add('hidden')
    this.container.querySelector('#drop-zone')!.classList.remove('hidden')
    this.container.querySelector('.size-hint')!.classList.remove('hidden')
    const fileInput = this.container.querySelector<HTMLInputElement>('#file-input')!
    fileInput.value = ''
  }

  // ── Pre-render double-buffer (#2) ──────────────────────────────────────────

  private clearPreRender() {
    this.nextBitmap?.close()
    this.nextBitmap = null
    this.nextBitmapForIndex = -1
    this.preparingBitmap = false
  }

  private scheduleNextBitmap() {
    if (this.preparingBitmap || this.pendingIndices.length === 0) return
    const nextPos = (this.pendingPos + 1) % this.pendingIndices.length
    const nextIdx = this.pendingIndices[nextPos]
    if (nextIdx === undefined || nextIdx === this.nextBitmapForIndex) return
    void this.prepareNextBitmap(nextIdx)
  }

  private async prepareNextBitmap(index: number) {
    if (this.preparingBitmap || index >= this.chunks.length) return
    this.preparingBitmap = true
    try {
      const dataUrl = await QRCode.toDataURL(encodeChunk(this.chunks[index]), {
        errorCorrectionLevel: 'L',
        margin: 2,
        width: 320,
        color: { dark: '#000000', light: '#ffffff' },
      }) as string
      const img = new Image()
      img.src = dataUrl
      await img.decode()
      const bitmap = await createImageBitmap(img)
      this.nextBitmap?.close()
      this.nextBitmap = bitmap
      this.nextBitmapForIndex = index
    } catch {
      // Ignore render failures; fallback will handle it
    } finally {
      this.preparingBitmap = false
    }
  }

  private renderChunk(index: number) {
    if (this.done || this.chunks.length === 0) return

    if (this.nextBitmapForIndex === index && this.nextBitmap) {
      const canvas = this.container.querySelector<HTMLCanvasElement>('#qr-canvas')!
      canvas.width = canvas.height = 320
      canvas.getContext('2d')!.drawImage(this.nextBitmap, 0, 0)
      this.nextBitmapForIndex = -1
      this.nextBitmap = null
      this.updateProgressUI(index)
      this.scheduleNextBitmap()
    } else if (!this.rendering) {
      void this.renderChunkFallback(index)
    }
  }

  private async renderChunkFallback(index: number) {
    if (this.rendering || this.chunks.length === 0 || this.done) return
    this.rendering = true
    try {
      const canvas = this.container.querySelector<HTMLCanvasElement>('#qr-canvas')!
      await QRCode.toCanvas(canvas, encodeChunk(this.chunks[index]), {
        errorCorrectionLevel: 'L',
        margin: 2,
        width: 320,
        color: { dark: '#000000', light: '#ffffff' },
      })
      if (this.done) return
      this.updateProgressUI(index)
      this.scheduleNextBitmap()
    } finally {
      this.rendering = false
    }
  }

  private updateProgressUI(index: number) {
    if (this.done) return
    const total = this.chunks.length
    const acked = this.ackedChunks.size
    this.container.querySelector('#chunk-counter')!.textContent = `表示中: ${index + 1} / ${total}`
    const fill = this.container.querySelector<HTMLElement>('#progress-fill')!
    fill.style.width = `${(acked / total) * 100}%`
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────

  private updateFpsDisplay() {
    this.container.querySelector('#fps-display')!.textContent = String(this.fps)
  }

  private updateChunkSizeDisplay() {
    const el = this.container.querySelector('#chunk-size-display')
    if (el) el.textContent = String(this.chunkSize)
    const slider = this.container.querySelector<HTMLInputElement>('#chunk-size-slider')
    if (slider && !this.autoChunkSize) slider.value = String(this.chunkSize)
  }

  private updateTransferEstimate() {
    const el = this.container.querySelector('#transfer-estimate')!
    if (this.chunks.length === 0) {
      el.classList.add('hidden')
      return
    }
    const seconds = this.chunks.length / this.fps
    el.textContent = `推定転送時間: ${formatTransferTime(seconds)} (${this.fps} fps 時)`
    el.classList.remove('hidden')
  }

  private rebuildPending() {
    this.pendingIndices = []
    for (let i = 0; i < this.chunks.length; i++) {
      if (!this.ackedChunks.has(i)) this.pendingIndices.push(i)
    }
    if (this.pendingPos >= this.pendingIndices.length) this.pendingPos = 0

    // Invalidate pre-render if that chunk is now acked
    if (this.nextBitmapForIndex !== -1 && !this.pendingIndices.includes(this.nextBitmapForIndex)) {
      this.nextBitmap?.close()
      this.nextBitmap = null
      this.nextBitmapForIndex = -1
    }
  }

  // ── ACK camera ─────────────────────────────────────────────────────────────

  private async startAckCamera() {
    const video = this.container.querySelector<HTMLVideoElement>('#ack-video')!
    const canvas = this.container.querySelector<HTMLCanvasElement>('#ack-scan-canvas')!
    this.ackVideo = video
    this.ackScanCanvas = canvas
    this.ackScanCtx = canvas.getContext('2d', { willReadFrequently: true })!
    this.workerBusy = false

    const switchBtn = this.container.querySelector<HTMLElement>('#switch-ack-camera-btn')
    if (switchBtn && !switchBtn.dataset.bound) {
      switchBtn.dataset.bound = '1'
      switchBtn.addEventListener('click', () => void this.switchAckCamera())
    }

    try {
      this.ackStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: this.ackFacingMode }, width: { ideal: 640 }, height: { ideal: 480 } },
      })
      video.srcObject = this.ackStream
      await video.play()
      this.container.querySelector('#ack-camera-status')!.textContent =
        '受信確認QRを探しています...'
      this.ackScanLoop()
    } catch {
      this.container.querySelector('#ack-camera-status')!.textContent =
        'カメラ起動失敗 — 受信完了後に手動で終了してください'
      const ackSection = this.container.querySelector('#ack-scan-section')!
      if (!ackSection.querySelector('#manual-done-btn')) {
        const btn = document.createElement('button')
        btn.id = 'manual-done-btn'
        btn.className = 'btn-secondary'
        btn.textContent = '手動で転送完了にする'
        btn.style.marginTop = '0.5rem'
        btn.addEventListener('click', () => {
          this.container.querySelector('#ack-info')!.textContent =
            `全 ${this.chunks.length} チャンクを送信しました（受信確認なし）`
          this.showSendComplete()
        })
        ackSection.appendChild(btn)
      }
    }
  }

  private ackScanLoop() {
    this.ackAnimFrame = requestAnimationFrame(() => this.ackScanLoop())

    if (this.workerBusy) return

    const now = performance.now()
    if (now - this.lastAckScanTime < 50) return
    this.lastAckScanTime = now

    if (!this.ackVideo || this.ackVideo.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) return

    this.ackScanCanvas.width = this.ackVideo.videoWidth
    this.ackScanCanvas.height = this.ackVideo.videoHeight
    this.ackScanCtx.drawImage(this.ackVideo, 0, 0)

    const imageData = this.ackScanCtx.getImageData(
      0, 0, this.ackScanCanvas.width, this.ackScanCanvas.height,
    )
    this.workerBusy = true
    // (#3) Transfer buffer ownership to worker — zero-copy
    this.scanWorker.postMessage(
      { data: imageData.data, width: imageData.width, height: imageData.height },
      [imageData.data.buffer],
    )
  }

  private processAckData(raw: string) {
    const payload = decodeAck(raw)
    if (!payload) return
    if (payload.id !== this.chunks[0]?.id) return

    const ackedSet = parseAckBitmask(payload.rcv, payload.t)
    this.ackedChunks = ackedSet
    this.rebuildPending()

    // Completion check before adaptive adjustments: applyChunkSizeChange resets the
    // transfer mid-function and would prevent showSendComplete from ever firing.
    if (this.pendingIndices.length === 0) {
      this.showSendComplete()
      return
    }

    void this.renderChunk(this.pendingIndices[this.pendingPos])

    const acked = ackedSet.size
    const total = payload.t

    this.container.querySelector('#ack-info')!.textContent =
      `確認済: ${acked} / ${total} チャンク`
    this.container.querySelector('#ack-camera-status')!.textContent =
      `ACK受信 — ${acked} / ${total} チャンク確認済`

    const etaEl = this.container.querySelector('#eta-display')!
    if (acked > 0 && acked < total) {
      const eta = computeEta(acked, total, this.ackEtaSamples)
      if (eta !== null) {
        etaEl.textContent = eta
        etaEl.classList.remove('hidden')
      }
    } else {
      etaEl.classList.add('hidden')
    }

    // Adaptive fps (#4 — max raised to 15)
    if (this.autoFps && this.ackEtaSamples.length >= 2) {
      const oldest = this.ackEtaSamples[0]
      const latest = this.ackEtaSamples[this.ackEtaSamples.length - 1]
      const elapsed = (latest.t - oldest.t) / 1000
      if (elapsed >= 1.5 && latest.n > oldest.n) {
        const rate = (latest.n - oldest.n) / elapsed
        const targetFps = Math.max(2, Math.min(15, Math.ceil(rate * 1.3)))
        if (targetFps !== this.fps) {
          this.fps = targetFps
          this.updateFpsDisplay()
          this.updateTransferEstimate()
          const slider = this.container.querySelector<HTMLInputElement>('#fps-slider')!
          slider.value = String(this.fps)
          if (this.interval !== null) {
            this.stopAnimation()
            this.startAnimation()
          }
        }
      }
    }

    // Adaptive chunk size — only during first 10% of transfer to avoid resetting received progress
    if (this.autoChunkSize && this.ackEtaSamples.length >= 3
        && this.ackedChunks.size < Math.ceil(this.chunks.length * 0.1)) {
      const now = Date.now()
      const oldest = this.ackEtaSamples[0]
      const latest = this.ackEtaSamples[this.ackEtaSamples.length - 1]
      const elapsed = (latest.t - oldest.t) / 1000
      if (elapsed >= 5 && now - this.chunkSizeLastChange > 15000) {
        const ackRate = (latest.n - oldest.n) / elapsed
        const ratio = ackRate / Math.max(1, this.fps)
        let newSize: number | null = null
        if (ratio > 0.85 && this.chunkSize < 1000) {
          newSize = Math.min(1000, this.chunkSize + 100)
        } else if (ratio < 0.40 && this.chunkSize > 200) {
          newSize = Math.max(200, this.chunkSize - 100)
        }
        if (newSize !== null) void this.applyChunkSizeChange(newSize)
      }
    }
  }

  private showSendComplete() {
    this.done = true
    this.stopAnimation()
    this.stopAckCamera()

    const qrWrapper = this.container.querySelector('.qr-wrapper')!
    qrWrapper.innerHTML =
      '<div class="success-icon" style="width:80px;height:80px;font-size:2rem">✓</div>'

    this.container.querySelector('#chunk-counter')!.textContent = '転送完了'
    this.container.querySelector<HTMLElement>('#progress-fill')!.style.width = '100%'
    this.container.querySelector('#ack-info')!.textContent =
      `全 ${this.chunks.length} チャンクの受信を確認しました`
    this.container.querySelector('#eta-display')!.classList.add('hidden')
    this.container.querySelector('#ack-scan-section')!.classList.add('hidden')
  }

  private async switchAckCamera() {
    this.ackFacingMode = this.ackFacingMode === 'user' ? 'environment' : 'user'
    cancelAnimationFrame(this.ackAnimFrame)
    this.stopAckCamera()
    await this.startAckCamera()
  }

  private stopAckCamera() {
    cancelAnimationFrame(this.ackAnimFrame)
    this.workerBusy = false
    this.ackStream?.getTracks().forEach(t => t.stop())
    this.ackStream = null
  }

  destroy() {
    this.stopAnimation()
    this.stopAckCamera()
    this.clearPreRender()
    this.scanWorker.terminate()
  }
}
