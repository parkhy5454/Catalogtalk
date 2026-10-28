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

// ~0.35s of shaped noise: a quick rustle that decays, like paper sliding.
function makeRustle(c: AudioContext): AudioBuffer {
  const duration = 0.35
  const length = Math.floor(c.sampleRate * duration)
  const buffer = c.createBuffer(1, length, c.sampleRate)
  const data = buffer.getChannelData(0)
  const attack = Math.floor(c.sampleRate * 0.012)
  for (let i = 0; i < length; i++) {
    const env = (i < attack ? i / attack : 1) * Math.pow(1 - i / length, 2.4)
    data[i] = (Math.random() * 2 - 1) * env
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
  const band = c.createBiquadFilter()
  band.type = 'bandpass'
  band.frequency.value = 2600
  band.Q.value = 0.8
  const gain = c.createGain()
  gain.gain.value = 0.55
  src.connect(band).connect(gain).connect(c.destination)
  src.start()
}
