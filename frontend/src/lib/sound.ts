// Synthesised sound design (no audio files). Off by default; only ever started by an
// explicit user action. Every sound is subtle and short, or a quiet ambient bed.

type Ambient = { gain: GainNode; stop: () => void }

class SoundEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noise: AudioBuffer | null = null
  private ambient: Ambient | null = null
  private rainBed: Ambient | null = null
  enabled = false

  private ensure(): AudioContext | null {
    if (typeof window === 'undefined') return null
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return null
      this.ctx = new Ctor()
      this.master = this.ctx.createGain()
      this.master.gain.value = 0
      this.master.connect(this.ctx.destination)
      const len = this.ctx.sampleRate * 2
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
      const data = this.noise.getChannelData(0)
      let last = 0
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1
        last = (last + 0.02 * white) / 1.02 // brown-ish noise: soft, never hissy
        data[i] = last * 3.5
      }
    }
    return this.ctx
  }

  async enable() {
    const ctx = this.ensure()
    if (!ctx || !this.master) return
    await ctx.resume()
    this.enabled = true
    this.master.gain.cancelScheduledValues(ctx.currentTime)
    this.master.gain.linearRampToValueAtTime(0.55, ctx.currentTime + 0.8)
    this.startAmbient()
  }

  disable() {
    this.enabled = false
    if (!this.ctx || !this.master) return
    const t = this.ctx.currentTime
    this.master.gain.cancelScheduledValues(t)
    this.master.gain.linearRampToValueAtTime(0, t + 0.4)
    window.setTimeout(() => {
      this.ambient?.stop()
      this.ambient = null
      this.rainBed?.stop()
      this.rainBed = null
      if (!this.enabled) void this.ctx?.suspend()
    }, 450)
  }

  private noiseSource(): AudioBufferSourceNode | null {
    if (!this.ctx || !this.noise) return null
    const src = this.ctx.createBufferSource()
    src.buffer = this.noise
    src.loop = true
    return src
  }

  /** Field ambience: low wind plus a faint 100 Hz electrical hum from the substation. */
  private startAmbient() {
    if (this.ambient || !this.ctx || !this.master) return
    const ctx = this.ctx
    const gain = ctx.createGain()
    gain.gain.value = 0
    gain.connect(this.master)
    const wind = this.noiseSource()!
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 420
    const windGain = ctx.createGain()
    windGain.gain.value = 0.05
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 0.08
    const lfoGain = ctx.createGain()
    lfoGain.gain.value = 0.03
    lfo.connect(lfoGain).connect(windGain.gain)
    wind.connect(lp).connect(windGain).connect(gain)
    const hum = ctx.createOscillator()
    hum.type = 'sine'
    hum.frequency.value = 100
    const humGain = ctx.createGain()
    humGain.gain.value = 0.006
    hum.connect(humGain).connect(gain)
    wind.start()
    lfo.start()
    hum.start()
    gain.gain.linearRampToValueAtTime(1, ctx.currentTime + 2.5)
    this.ambient = {
      gain,
      stop: () => {
        for (const n of [wind, lfo, hum]) {
          try {
            n.stop()
          } catch {
            /* already stopped */
          }
        }
        gain.disconnect()
      },
    }
  }

  /** Relay / contactor click. */
  click(intensity = 1) {
    if (!this.enabled || !this.ctx || !this.master) return
    const ctx = this.ctx
    const src = this.noiseSource()!
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 2400
    bp.Q.value = 2.5
    const g = ctx.createGain()
    const t = ctx.currentTime
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.35 * intensity, t + 0.004)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06)
    src.connect(bp).connect(g).connect(this.master)
    src.start(t)
    src.stop(t + 0.08)
  }

  /** Pump start: contactor click, then a motor hum spinning up and fading. */
  pumpStart() {
    if (!this.enabled || !this.ctx || !this.master) return
    this.click(0.8)
    const ctx = this.ctx
    const t = ctx.currentTime + 0.04
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(18, t)
    osc.frequency.exponentialRampToValueAtTime(49, t + 0.7)
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 260
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.06, t + 0.5)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2)
    osc.connect(lp).connect(g).connect(this.master)
    osc.start(t)
    osc.stop(t + 2.3)
  }

  /** Soft water swell. */
  water() {
    if (!this.enabled || !this.ctx || !this.master) return
    const ctx = this.ctx
    const src = this.noiseSource()!
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 900
    bp.Q.value = 0.8
    const g = ctx.createGain()
    const t = ctx.currentTime
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.35)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6)
    src.connect(bp).connect(g).connect(this.master)
    src.start(t)
    src.stop(t + 1.7)
  }

  rain(on: boolean) {
    if (!this.ctx || !this.master) return
    const ctx = this.ctx
    if (on && this.enabled && !this.rainBed) {
      const src = this.noiseSource()!
      const hp = ctx.createBiquadFilter()
      hp.type = 'highpass'
      hp.frequency.value = 700
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = 5200
      const g = ctx.createGain()
      g.gain.value = 0
      src.connect(hp).connect(lp).connect(g).connect(this.master)
      src.start()
      g.gain.linearRampToValueAtTime(0.16, ctx.currentTime + 1.5)
      this.rainBed = {
        gain: g,
        stop: () => {
          g.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.2)
          window.setTimeout(() => {
            try {
              src.stop()
            } catch {
              /* stopped */
            }
          }, 1300)
        },
      }
    } else if (!on && this.rainBed) {
      this.rainBed.stop()
      this.rainBed = null
    }
  }

  /** Two-note confirmation chime when the optimiser finishes. */
  chime() {
    if (!this.enabled || !this.ctx || !this.master) return
    const ctx = this.ctx
    ;[659.25, 987.77].forEach((f, i) => {
      const t = ctx.currentTime + i * 0.12
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = f
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.08, t + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1)
      osc.connect(g).connect(this.master!)
      osc.start(t)
      osc.stop(t + 1.2)
    })
  }

  tick() {
    if (!this.enabled || !this.ctx || !this.master) return
    const ctx = this.ctx
    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.value = 1800
    const g = ctx.createGain()
    const t = ctx.currentTime
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.03, t + 0.003)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04)
    osc.connect(g).connect(this.master)
    osc.start(t)
    osc.stop(t + 0.05)
  }
}

export const sound = new SoundEngine()
