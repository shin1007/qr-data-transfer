import QRCode from 'qrcode'
import { splitBuffer } from './chunker'
import { isAckPayload, parseAckBitmask } from './protocol'
import type { ChunkPayload } from './protocol'
import { formatBytes, computeEta, formatTransferTime } from './utils'
import { shouldCompress, compressBuffer } from './compressor'

export class SenderView {
  private container: HTMLElement
  private chunks: ChunkPayload[] = []
  private pendingIndices: number[] = []
  private pendingPos = 0
  private interval: number | null = null
  private fps = 4
  private rendering = false
  private done = false

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
              <span class="speed-label">速度: <strong id="fps-display">4</strong> fps</span>
              <button class="btn-auto active" id="auto-fps-btn">自動</button>
            </div>
            <input type="range" id="fps-slider" min="1" max="10" value="4" disabled>
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

    const slider = this.container.querySelector<HTMLInputElement>('#fps-slider')!
    slider.addEventListener('input', () => {
      this.fps = parseInt(slider.value)
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
      slider.disabled = this.autoFps
      if (!this.autoFps) {
        this.fps = parseInt(slider.value)
        this.updateFpsDisplay()
        this.updateTransferEstimate()
      }
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
      // Only apply compression if it meaningfully reduces size (>5% gain)
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

    const id = crypto.randomUUID()
    this.chunks = splitBuffer(
      transferBuffer,
      file.name,
      id,
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

    this.container.querySelector('#drop-zone')!.classList.add('hidden')
    this.container.querySelector('.size-hint')!.classList.add('hidden')
    this.container.querySelector('#qr-area')!.classList.remove('hidden')

    const sizeStr = compressedSize !== null
      ? `${formatBytes(file.size)} → ${formatBytes(compressedSize)} (-${Math.round((1 - compressedSize / file.size) * 100)}%)`
      : formatBytes(file.size)
    this.container.querySelector('#file-info')!.textContent =
      `${file.name}  •  ${sizeStr}  •  ${this.chunks.length} チャンク`

    this.container.querySelector('#ack-info')!.textContent = '受信確認待機中...'
    this.updateTransferEstimate()

    void this.startAckCamera()
    this.startAnimation()
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
    this.container.querySelector('#qr-area')!.classList.add('hidden')
    this.container.querySelector('#drop-zone')!.classList.remove('hidden')
    this.container.querySelector('.size-hint')!.classList.remove('hidden')
    const fileInput = this.container.querySelector<HTMLInputElement>('#file-input')!
    fileInput.value = ''
  }

  private updateFpsDisplay() {
    this.container.querySelector('#fps-display')!.textContent = String(this.fps)
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
  }

  private async renderChunk(index: number) {
    if (this.rendering || this.chunks.length === 0 || this.done) return
    this.rendering = true
    try {
      const canvas = this.container.querySelector<HTMLCanvasElement>('#qr-canvas')!
      await QRCode.toCanvas(canvas, JSON.stringify(this.chunks[index]), {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 320,
        color: { dark: '#000000', light: '#ffffff' },
      })
      if (this.done) return
      const total = this.chunks.length
      const acked = this.ackedChunks.size
      this.container.querySelector('#chunk-counter')!.textContent = `表示中: ${index + 1} / ${total}`
      const fill = this.container.querySelector<HTMLElement>('#progress-fill')!
      fill.style.width = `${(acked / total) * 100}%`
    } finally {
      this.rendering = false
    }
  }

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
        video: { facingMode: this.ackFacingMode, width: { ideal: 640 }, height: { ideal: 480 } },
      })
      video.srcObject = this.ackStream
      await video.play()
      this.container.querySelector('#ack-camera-status')!.textContent =
        '受信確認QRを探しています...'
      this.ackScanLoop()
    } catch {
      this.container.querySelector('#ack-camera-status')!.textContent =
        'カメラ起動失敗 — ACK確認なしで送信を継続'
    }
  }

  private ackScanLoop() {
    this.ackAnimFrame = requestAnimationFrame(() => this.ackScanLoop())

    if (this.workerBusy) return

    const now = performance.now()
    if (now - this.lastAckScanTime < 100) return
    this.lastAckScanTime = now

    if (!this.ackVideo || this.ackVideo.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) return

    this.ackScanCanvas.width = this.ackVideo.videoWidth
    this.ackScanCanvas.height = this.ackVideo.videoHeight
    this.ackScanCtx.drawImage(this.ackVideo, 0, 0)

    const imageData = this.ackScanCtx.getImageData(
      0, 0, this.ackScanCanvas.width, this.ackScanCanvas.height,
    )
    this.workerBusy = true
    this.scanWorker.postMessage({ data: imageData.data, width: imageData.width, height: imageData.height })
  }

  private processAckData(raw: string) {
    let payload: unknown
    try { payload = JSON.parse(raw) } catch { return }
    if (!isAckPayload(payload)) return
    if (payload.id !== this.chunks[0]?.id) return

    const ackedSet = parseAckBitmask(payload.rcv, payload.t)
    this.ackedChunks = ackedSet
    this.rebuildPending()

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

    // Adaptive fps: adjust based on receiver's ACK rate
    if (this.autoFps && this.ackEtaSamples.length >= 2) {
      const oldest = this.ackEtaSamples[0]
      const latest = this.ackEtaSamples[this.ackEtaSamples.length - 1]
      const elapsed = (latest.t - oldest.t) / 1000
      if (elapsed >= 1.5 && latest.n > oldest.n) {
        const rate = (latest.n - oldest.n) / elapsed
        const targetFps = Math.max(2, Math.min(10, Math.ceil(rate * 1.3)))
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

    if (this.pendingIndices.length === 0) {
      this.showSendComplete()
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
    this.scanWorker.terminate()
  }
}
