// Page-turn sound. Plays a real recorded page-turn clip from /public, and falls back to a
// synthesized rustle if the clip cannot be loaded. Browsers only allow audio after a user
// gesture, so call unlockAudio() on the first touch.

const SOUND_URL = '/sounds/page-turn.wav'

let ctx: AudioContext | null = null
let clip: AudioBuffer | null = null
let loadingClip = false
let synthNoise: AudioBuffer | null = null

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    ctx = new AC()
  }
  return ctx
}

function loadClip(c: AudioContext) {
  if (clip || loadingClip) return
  loadingClip = true
  fetch(SOUND_URL)
    .then((r) => r.arrayBuffer())
    .then((bytes) => c.decodeAudioData(bytes))
    .then((buf) => {
      clip = buf
    })
    .catch(() => undefined)
    .finally(() => {
      loadingClip = false
    })
}

// Fallback: ~0.5s of soft, low-passed noise with a slow swell and long fade.
function makeRustle(c: AudioContext): AudioBuffer {
  const duration = 0.5
  const length = Math.floor(c.sampleRate * duration)
  const buffer = c.createBuffer(1, length, c.sampleRate)
  const data = buffer.getChannelData(0)
  const attack = Math.floor(c.sampleRate * 0.04)
  let smooth = 0
  for (let i = 0; i < length; i++) {
    const t = i / length
    const env = (i < attack ? i / attack : 1) * Math.pow(1 - t, 3)
    smooth = smooth * 0.85 + (Math.random() * 2 - 1) * 0.15
    data[i] = smooth * env * 3
  }
  return buffer
}

export function unlockAudio() {
  const c = getContext()
  if (!c) return
  if (c.state === 'suspended') void c.resume().catch(() => undefined)
  loadClip(c)
}

// Short haptic tick on phones that support it (Android Chrome; iOS Safari ignores it).
function hapticTick() {
  try {
    navigator.vibrate?.(10)
  } catch {
    // Some in-app browsers throw: haptics are optional.
  }
}

export function playPageTurn() {
  hapticTick()
  const c = getContext()
  if (!c) return
  if (c.state === 'suspended') void c.resume().catch(() => undefined)
  loadClip(c)

  const src = c.createBufferSource()
  const gain = c.createGain()
  if (clip) {
    src.buffer = clip
    // Tame the low "thud" and lift the paper crispness of the recorded clip.
    const hp = c.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 450
    const presence = c.createBiquadFilter()
    presence.type = 'peaking'
    presence.frequency.value = 3000
    presence.Q.value = 1
    presence.gain.value = 5
    src.connect(hp).connect(presence).connect(gain)
    gain.gain.value = 0.9
  } else {
    if (!synthNoise) synthNoise = makeRustle(c)
    src.buffer = synthNoise
    const tone = c.createBiquadFilter()
    tone.type = 'lowpass'
    tone.frequency.value = 3200
    tone.Q.value = 0.5
    src.connect(tone)
    gain.gain.value = 0.35
    tone.connect(gain)
  }
  gain.connect(c.destination)
  src.start()
}
