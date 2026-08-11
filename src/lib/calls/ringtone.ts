/**
 * Synthetic Ringtone Generator using Web Audio API.
 *
 * Generates an incoming call chime without requiring external audio assets.
 * Handles audio context unlocking on initial user interaction and tab title
 * notification flashing when autoplay is restricted by browser policy.
 */

let sharedAudioCtx: AudioContext | null = null
let ringtoneInterval: number | null = null
let titleFlashInterval: number | null = null
let originalDocumentTitle = ''

/**
 * Ensures an AudioContext is instantiated and unlocked.
 * Listens once to 'pointerdown' on the document to resume suspended contexts.
 */
export function getUnlockedAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null

  if (!sharedAudioCtx) {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (AudioCtx) {
      sharedAudioCtx = new AudioCtx()
    }
  }

  if (sharedAudioCtx && sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume().catch(() => {
      // Ignored if user hasn't interacted yet
    })
  }

  return sharedAudioCtx
}

/**
 * Register global listener to unlock audio on first click/tap.
 */
export function registerAudioUnlockListener(): () => void {
  if (typeof window === 'undefined') return () => {}

  const unlock = () => {
    getUnlockedAudioContext()
    window.removeEventListener('pointerdown', unlock)
    window.removeEventListener('keydown', unlock)
  }

  window.addEventListener('pointerdown', unlock, { passive: true, once: true })
  window.addEventListener('keydown', unlock, { passive: true, once: true })

  return () => {
    window.removeEventListener('pointerdown', unlock)
    window.removeEventListener('keydown', unlock)
  }
}

/**
 * Play single chime burst (US Ringtone standard: 440Hz + 480Hz).
 */
function playChimeBurst(ctx: AudioContext) {
  try {
    const now = ctx.currentTime
    const osc1 = ctx.createOscillator()
    const osc2 = ctx.createOscillator()
    const gain = ctx.createGain()

    osc1.type = 'sine'
    osc1.frequency.setValueAtTime(440, now)

    osc2.type = 'sine'
    osc2.frequency.setValueAtTime(480, now)

    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(0.15, now + 0.05)
    gain.gain.setValueAtTime(0.15, now + 1.2)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.5)

    osc1.connect(gain)
    osc2.connect(gain)
    gain.connect(ctx.destination)

    osc1.start(now)
    osc2.start(now)
    osc1.stop(now + 1.5)
    osc2.stop(now + 1.5)
  } catch (err) {
    console.warn('[ringtone] Failed to play chime burst:', err)
  }
}

/**
 * Start repeating ringtone chime.
 */
export function startRingtone(): void {
  if (typeof window === 'undefined') return
  stopRingtone()

  const ctx = getUnlockedAudioContext()
  if (ctx) {
    playChimeBurst(ctx)
    ringtoneInterval = window.setInterval(() => {
      if (ctx.state === 'running') {
        playChimeBurst(ctx)
      }
    }, 3000)
  }

  startTitleFlash('📞 Llamada entrante...')
}

/**
 * Stop ringtone chime and restore document title.
 */
export function stopRingtone(): void {
  if (typeof window === 'undefined') return

  if (ringtoneInterval !== null) {
    window.clearInterval(ringtoneInterval)
    ringtoneInterval = null
  }

  stopTitleFlash()
}

/**
 * Flash document title to alert user even when tab is backgrounded.
 */
export function startTitleFlash(flashText: string): void {
  if (typeof document === 'undefined') return
  if (titleFlashInterval !== null) return

  originalDocumentTitle = document.title || 'wacrm'
  let step = 0

  titleFlashInterval = window.setInterval(() => {
    document.title = step % 2 === 0 ? flashText : originalDocumentTitle
    step++
  }, 1000)
}

/**
 * Restore original document title.
 */
export function stopTitleFlash(): void {
  if (typeof document === 'undefined') return

  if (titleFlashInterval !== null) {
    window.clearInterval(titleFlashInterval)
    titleFlashInterval = null
  }

  if (originalDocumentTitle) {
    document.title = originalDocumentTitle
    originalDocumentTitle = ''
  }
}
