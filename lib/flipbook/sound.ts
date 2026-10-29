// Page-turn sound, synthesized with Web Audio (no audio file to host or license).
// Browsers only allow audio after a user gesture, so call unlockAudio() on the first touch.

let ctx: AudioContext | null = null
let noise: AudioBuffer | null = null

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return null
    ctx = new AC()
  }
  return ctx
}

// ~0.5s of soft, low-passed noise with a slow swell and long fade: a paper "shhh", not a click.
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
    // One-pole low-pass on white noise removes the harsh high-frequency "tick" component.
    smooth = smooth * 0.85 + (Math.random() * 2 - 1) * 0.15
    data[i] = smooth * env * 3
  }
  return buffer
}

export function unlockAudio() {
  const c = getContext()
  if (c && c.state === 'suspended') void c.resume().catch(() => undefined)
}

export function playPageTurn() {
  const c = getContext()
  if (!c) return
  if (c.state === 'suspended') void c.resume().catch(() => undefined)
  if (!noise) noise = makeRustle(c)

  const src = c.createBufferSource()
  src.buffer = noise
  const tone = c.createBiquadFilter()
  tone.type = 'lowpass'
  tone.frequency.value = 3200
  tone.Q.value = 0.5
  const gain = c.createGain()
  gain.gain.value = 0.35
  src.connect(tone).connect(gain).connect(c.destination)
  src.start()
}
