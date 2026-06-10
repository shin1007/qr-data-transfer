import QRCode from 'qrcode'
import { reassembleChunks } from './chunker'
import { decodeChunk, encodeAck, buildAckBitmask } from './protocol'
import type { ChunkPayload, AckPayload } from './protocol'
import { formatBytes, computeEta } from './utils'
import { decompressBuffer } from './compressor'

export class ReceiverView {
  private container: HTMLElement
  private video!: HTMLVideoElement
  private canvas!: HTMLCanvasElement
  private ctx!: CanvasRenderingContext2D
  private animFrame = 0
  private stream: MediaStream | null = null
  private lastScanTime = 0

  private transferId: string | null = null
  private totalChunks = 0
  private receivedChunks = new Map<number, ChunkPayload>()
  private filename = 'download'
  private fileSize = 0
  private lastScanned = ''
  private downloadBlob: Blob | null = null

  private ackRendering = false
  private etaSamples: Array<{t: number, n: number}> = []
  private isCompressed = false
  private facingMode: 'user' | 'environment' = 'user'

  // Web Worker for jsQR decoding
  private scanWorker: Worker
  private workerBusy = false

  constructor(container: HTMLElement) {
    this.container = container
    this.scanWorker = new Worker(new URL('./qr-worker.ts', import.meta.url), { type: 'module' })
    this.scanWorker.onmessage = (e: MessageEvent<string | null>) => {
      this.workerBusy = false
      const data = e.data
      if (data && data !== this.lastScanned) {
        this.lastScanned = data
        this.processQRData(data)
      }
    }
    this.render()
  }

  private render() {
    this.container.innerHTML = `
      <div class="view">
        <div class="ack-qr-section hidden" id="ack-qr-section">
          <div class="ack-qr-wrapper">
            <canvas id="ack-qr-canvas"></canvas>
          </div>
          <p class="section-label">受信確認QR<br>送信側のカメラにかざしてください</p>
        </div>

        <div id="camera-area">
          <div class="video-wrapper">
            <video id="preview-video" autoplay playsinline muted></video>
            <canvas id="scan-canvas" hidden></canvas>
            <div class="scan-overlay">
              <div class="scan-frame"></div>
            </div>
          </div>
          <div class="scan-info" style="margin-top:1rem">
            <p id="scan-status" class="status">カメラを起動中...</p>
            <div class="progress-bar hidden" id="recv-progress-bar">
              <div id="recv-progress-fill" style="width:0%"></div>
            </div>
            <p id="recv-counter" class="counter hidden">0 / 0</p>
            <p id="recv-eta" class="eta hidden"></p>
            <p id="recv-file-info" class="file-info hidden"></p>
          </div>
          <div style="display:flex;justify-content:center;gap:0.75rem;margin-top:1rem">
            <button class="btn-ghost" id="switch-camera-btn">⇄ カメラ切替</button>
            <button class="btn-ghost" id="stop-btn">✕ 停止</button>
          </div>
        </div>

        <div class="done-area hidden" id="done-area">
          <div class="success-icon">✓</div>
          <h3 id="done-filename"></h3>
          <p id="done-size"></p>
          <button class="btn-primary" id="download-btn">ダウンロード</button>
          <button class="btn-ghost" id="scan-again-btn">再スキャン</button>
        </div>

        <div class="error-area hidden" id="error-area">
          <p id="error-message"></p>
          <button class="btn-ghost" id="retry-btn">再試行</button>
        </div>
      </div>
    `

    this.video = this.container.querySelector<HTMLVideoElement>('#preview-video')!
    this.canvas = this.container.querySelector<HTMLCanvasElement>('#scan-canvas')!
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!

    this.container.querySelector('#stop-btn')?.addEventListener('click', () => this.stop())
    this.container.querySelector('#switch-camera-btn')?.addEventListener('click', () => void this.switchCamera())
    this.container.querySelector('#download-btn')?.addEventListener('click', () => this.download())
    this.container.querySelector('#scan-again-btn')?.addEventListener('click', () => this.reset())
    this.container.querySelector('#retry-btn')?.addEventListener('click', () => void this.startCamera())

    void this.startCamera()
  }

  private async startCamera() {
    this.container.querySelector('#error-area')!.classList.add('hidden')
    this.container.querySelector('#camera-area')!.classList.remove('hidden')
    this.setStatus('カメラを起動中...')
    this.workerBusy = false

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: this.facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } },
      })
      this.video.srcObject = this.stream
      await this.video.play()
      this.setStatus('QRコードにカメラを向けてください')
      this.scanLoop()
    } catch (err) {
      this.showError(`カメラの起動に失敗しました: ${(err as Error).message}`)
    }
  }

  private scanLoop() {
    this.animFrame = requestAnimationFrame(() => this.scanLoop())

    if (this.workerBusy) return

    const now = performance.now()
    if (now - this.lastScanTime < 50) return
    this.lastScanTime = now

    if (this.video.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) return

    this.canvas.width = this.video.videoWidth
    this.canvas.height = this.video.videoHeight
    this.ctx.drawImage(this.video, 0, 0)

    const imageData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height)
    this.workerBusy = true
    // (#3) Transfer buffer ownership to worker — zero-copy
    this.scanWorker.postMessage(
      { data: imageData.data, width: imageData.width, height: imageData.height },
      [imageData.data.buffer],
    )
  }

  private processQRData(raw: string) {
    const payload = decodeChunk(raw)
    if (!payload) return

    if (this.transferId !== payload.id) {
      if (this.transferId !== null && this.receivedChunks.size > 0) {
        this.setStatus(`新しい転送を検出 — 受信済み ${this.receivedChunks.size} チャンクをリセット`)
      }
      this.transferId = payload.id
      this.totalChunks = payload.t
      this.receivedChunks.clear()
      this.filename = 'download'
      this.fileSize = 0
      this.isCompressed = false
      this.etaSamples = []
      this.container.querySelector('#recv-progress-bar')!.classList.remove('hidden')
      this.container.querySelector('#recv-counter')!.classList.remove('hidden')
    }

    if (payload.i === 0 && payload.n) {
      this.filename = payload.n
      this.fileSize = payload.s ?? 0
      this.isCompressed = payload.z === 1
      const info = this.container.querySelector('#recv-file-info')!
      info.textContent = `${this.filename}  •  ${formatBytes(this.fileSize)}  •  ${this.totalChunks} チャンク`
      info.classList.remove('hidden')
    }

    if (this.receivedChunks.has(payload.i)) return

    if (this.receivedChunks.size === 0) {
      this.container.querySelector('#ack-qr-section')!.classList.remove('hidden')
    }

    this.receivedChunks.set(payload.i, payload)
    this.updateProgress()

    if (this.receivedChunks.size === this.totalChunks) {
      void this.completeTransfer()
    }
  }

  private updateProgress() {
    const count = this.receivedChunks.size
    const total = this.totalChunks
    this.setStatus(`受信中... ${count} / ${total} チャンク`)
    this.container.querySelector('#recv-counter')!.textContent = `${count} / ${total}`
    const fill = this.container.querySelector<HTMLElement>('#recv-progress-fill')!
    fill.style.width = `${total > 0 ? (count / total) * 100 : 0}%`

    const etaEl = this.container.querySelector('#recv-eta')!
    if (count > 0 && count < total) {
      const eta = computeEta(count, total, this.etaSamples)
      if (eta !== null) {
        etaEl.textContent = eta
        etaEl.classList.remove('hidden')
      }
    } else {
      etaEl.classList.add('hidden')
    }

    void this.updateAckQr()
  }

  private async updateAckQr() {
    if (this.ackRendering || !this.transferId) return
    const ackCanvas = this.container.querySelector<HTMLCanvasElement>('#ack-qr-canvas')
    if (!ackCanvas) return

    this.ackRendering = true
    const payload: AckPayload = {
      v: 1,
      type: 'ack',
      id: this.transferId,
      t: this.totalChunks,
      rcv: buildAckBitmask(this.receivedChunks.keys(), this.totalChunks),
    }
    try {
      await QRCode.toCanvas(ackCanvas, encodeAck(payload), {
        errorCorrectionLevel: 'L',
        margin: 1,
        width: 110,
        color: { dark: '#000000', light: '#ffffff' },
      })
    } catch {
      const label = this.container.querySelector<HTMLElement>('.section-label')
      if (label) label.textContent = 'ACK QR生成失敗（チャンク数過多）— 手動で完了を確認してください'
    } finally {
      this.ackRendering = false
    }
  }

  private async completeTransfer() {
    cancelAnimationFrame(this.animFrame)
    this.stopStream()

    void this.updateAckQr()

    try {
      const raw = reassembleChunks(this.receivedChunks, this.totalChunks)
      const finalBuffer = this.isCompressed
        ? await decompressBuffer(raw.buffer as ArrayBuffer)
        : raw.buffer as ArrayBuffer
      this.downloadBlob = new Blob([finalBuffer])
      this.container.querySelector('#camera-area')!.classList.add('hidden')
      this.container.querySelector('#recv-eta')!.classList.add('hidden')
      this.container.querySelector('#done-area')!.classList.remove('hidden')
      this.container.querySelector('#done-filename')!.textContent = this.filename
      this.container.querySelector('#done-size')!.textContent = formatBytes(finalBuffer.byteLength)
    } catch (err) {
      this.showError(`ファイル再構築に失敗: ${(err as Error).message}`)
    }
  }

  private download() {
    if (!this.downloadBlob) return
    const url = URL.createObjectURL(this.downloadBlob)
    const a = document.createElement('a')
    a.href = url
    a.download = this.filename
    a.click()
    URL.revokeObjectURL(url)
  }

  private reset() {
    this.transferId = null
    this.totalChunks = 0
    this.receivedChunks.clear()
    this.filename = 'download'
    this.fileSize = 0
    this.isCompressed = false
    this.lastScanned = ''
    this.downloadBlob = null
    this.etaSamples = []

    this.container.querySelector('#done-area')!.classList.add('hidden')
    this.container.querySelector('#ack-qr-section')!.classList.add('hidden')
    this.container.querySelector('#recv-progress-bar')!.classList.add('hidden')
    this.container.querySelector('#recv-counter')!.classList.add('hidden')
    this.container.querySelector('#recv-eta')!.classList.add('hidden')
    this.container.querySelector('#recv-file-info')!.classList.add('hidden')
    void this.startCamera()
  }

  private async switchCamera() {
    this.facingMode = this.facingMode === 'user' ? 'environment' : 'user'
    cancelAnimationFrame(this.animFrame)
    this.stopStream()
    await this.startCamera()
  }

  private stop() {
    cancelAnimationFrame(this.animFrame)
    this.stopStream()
  }

  private stopStream() {
    this.stream?.getTracks().forEach(t => t.stop())
    this.stream = null
  }

  private setStatus(msg: string) {
    this.container.querySelector('#scan-status')!.textContent = msg
  }

  private showError(msg: string) {
    this.container.querySelector('#camera-area')!.classList.add('hidden')
    this.container.querySelector('#error-area')!.classList.remove('hidden')
    this.container.querySelector('#error-message')!.textContent = msg
  }

  destroy() {
    cancelAnimationFrame(this.animFrame)
    this.stopStream()
    this.scanWorker.terminate()
  }
}
