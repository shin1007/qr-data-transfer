import './style.css'
import { SenderView } from './sender'
import { ReceiverView } from './receiver'

type Mode = 'home' | 'send' | 'receive'

let currentView: SenderView | ReceiverView | null = null

function navigate(mode: Mode) {
  currentView?.destroy()
  currentView = null

  const app = document.querySelector<HTMLDivElement>('#app')!

  if (mode === 'home') {
    app.innerHTML = `
      <div class="home">
        <div class="home-logo">
          <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor" opacity="0.9"/>
            <rect x="7" y="7" width="10" height="10" rx="1" fill="var(--bg)"/>
            <rect x="9" y="9" width="6" height="6" rx="0.5" fill="currentColor"/>
            <rect x="28" y="4" width="16" height="16" rx="2" fill="currentColor" opacity="0.9"/>
            <rect x="31" y="7" width="10" height="10" rx="1" fill="var(--bg)"/>
            <rect x="33" y="9" width="6" height="6" rx="0.5" fill="currentColor"/>
            <rect x="4" y="28" width="16" height="16" rx="2" fill="currentColor" opacity="0.9"/>
            <rect x="7" y="31" width="10" height="10" rx="1" fill="var(--bg)"/>
            <rect x="9" y="33" width="6" height="6" rx="0.5" fill="currentColor"/>
            <rect x="28" y="28" width="6" height="6" rx="1" fill="currentColor"/>
            <rect x="38" y="28" width="6" height="6" rx="1" fill="currentColor"/>
            <rect x="28" y="38" width="6" height="6" rx="1" fill="currentColor"/>
            <rect x="38" y="38" width="6" height="6" rx="1" fill="currentColor"/>
          </svg>
        </div>
        <h1>QR転送</h1>
        <p class="home-desc">QRコードアニメーションでファイルをオフライン転送</p>
        <div class="home-buttons">
          <button class="btn-primary btn-large" id="send-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round"
                d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"/>
            </svg>
            送信
          </button>
          <button class="btn-outline btn-large" id="receive-btn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round"
                d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"/>
            </svg>
            受信
          </button>
        </div>
        <p class="home-note">ネットワーク不要・完全ローカル転送</p>
      </div>
    `
    document.querySelector('#send-btn')?.addEventListener('click', () => navigate('send'))
    document.querySelector('#receive-btn')?.addEventListener('click', () => navigate('receive'))
    return
  }

  const title = mode === 'send' ? '送信' : '受信'
  app.innerHTML = `
    <header>
      <button class="back-btn" id="back-btn" aria-label="ホームに戻る">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18"/>
        </svg>
      </button>
      <h1>${title}</h1>
    </header>
    <main id="view-container"></main>
  `
  document.querySelector('#back-btn')?.addEventListener('click', () => navigate('home'))

  const container = document.querySelector<HTMLElement>('#view-container')!
  if (mode === 'send') {
    currentView = new SenderView(container)
  } else {
    currentView = new ReceiverView(container)
  }
}

navigate('home')
