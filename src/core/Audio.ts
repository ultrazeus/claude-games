/**
 * Procedural audio bus.
 *
 * Everything is synthesised at runtime, so there is no sample pipeline to keep in
 * sync across events and nothing to download before the game is playable. The
 * context starts suspended (browser policy) and is resumed on the first gesture.
 */
type BusName = 'sfx' | 'music'

/**
 * Every sustained bed is scaled by this.
 *
 * The beds were authored at 0.03–0.05 each with up to two running per event and
 * nothing on the music bus to sit behind, so they *were* the soundtrack. With
 * music playing they are ambience, and ambience belongs under it.
 */
const AMBIENCE_TRIM = 0.45

/**
 * Floor for every exponential gain ramp.
 *
 * `exponentialRampToValueAtTime` throws a RangeError on a target of 0 (or any
 * denormal), and an exponential curve cannot reach zero anyway. Callers compute
 * gains from gameplay — BMX's landing thud is
 * `clamp01(impact / 1500) * 0.2` — so a soft enough landing produces exactly 0
 * and took the whole game loop down with it. `??` does not help: it defaults on
 * null and undefined, not on a real 0.
 *
 * Every capture in this project ran muted, and both `tone` and `noise` return
 * early when muted, so the entire path was unreachable to the rig that reviewed
 * this game 65 times. Only playing it with the sound on could find it.
 */
const MIN_GAIN = 0.0001

export interface ToneSpec {
  /** Start frequency in Hz. */
  freq: number
  /** End frequency; defaults to `freq` (no sweep). */
  toFreq?: number
  /** Seconds. */
  duration: number
  type?: OscillatorType
  /** Peak gain 0..1 before bus volume. */
  gain?: number
  /** Seconds of attack; the rest of the duration is decay. */
  attack?: number
  /** Detuned second oscillator for thickness, in cents. */
  detune?: number
  bus?: BusName
  /** Delay before the note starts, seconds. */
  delay?: number
}

export interface NoiseSpec {
  duration: number
  gain?: number
  /** Lowpass cutoff start/end, Hz. */
  cutoff?: number
  toCutoff?: number
  /** Bandpass Q. Higher is more tonal. */
  q?: number
  attack?: number
  bus?: BusName
  delay?: number
}

export class AudioBus {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private buses: Record<BusName, GainNode | null> = { sfx: null, music: null }
  private noiseBuffer_: AudioBuffer | null = null
  private volumes: Record<BusName, number> = { sfx: 0.85, music: 0.55 }
  private masterVolume = 0.9
  private muted = false
  private ambience = true
  /** Live `loopNoise` beds, so the ambience switch reaches ones already playing. */
  private beds = new Set<{ apply(): void }>()
  /** Beds requested before the graph existed; built by `unlock`. */
  private pendingBeds = new Set<{ materialise(): void }>()
  private unlocked = false

  /** Safe to call repeatedly; only the first gesture does work. */
  unlock(): void {
    if (this.unlocked) return
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    this.ctx = new Ctor({ latencyHint: 'interactive' })
    this.master = this.ctx.createGain()
    this.master.gain.value = this.muted ? 0 : this.masterVolume
    this.master.connect(this.ctx.destination)
    for (const name of ['sfx', 'music'] as const) {
      const g = this.ctx.createGain()
      g.gain.value = this.volumes[name]
      g.connect(this.master)
      this.buses[name] = g
    }
    this.buildNoise()
    this.unlocked = true
    // Anything a scene asked for before this point now gets its real nodes.
    const waiting = [...this.pendingBeds]
    this.pendingBeds.clear()
    for (const b of waiting) b.materialise()
    void this.ctx.resume()
  }

  get ready(): boolean {
    return this.unlocked && this.ctx !== null && this.ctx.state === 'running'
  }

  get currentTime(): number {
    return this.ctx?.currentTime ?? 0
  }

  resume(): void {
    if (this.ctx?.state === 'suspended') void this.ctx.resume()
  }

  setMuted(m: boolean): void {
    this.muted = m
    if (this.master) this.master.gain.value = m ? 0 : this.masterVolume
  }

  get isMuted(): boolean {
    return this.muted
  }

  /* --- access for `Music.ts` ------------------------------------------- */
  /* The sequencer schedules at absolute `AudioContext` times, which `tone()`
   * and `noise()` cannot express (they are relative to `currentTime` at the
   * moment of the call). So it builds its own nodes and needs the graph. */

  get context(): AudioContext | null {
    return this.ctx
  }

  get musicBus(): GainNode | null {
    return this.buses.music
  }

  get noiseBuffer(): AudioBuffer | null {
    return this.noiseBuffer_
  }

  /**
   * Ambience on/off — the wind, wave and tyre beds.
   *
   * These are `loopNoise` voices: broadband pink noise behind a Q≈0.6 lowpass,
   * which is barely a filter. Six events' worth of them, with no music on the
   * other bus, is what the first person to actually listen to this game called
   * "annoying white noise". They are quieter now and they can be turned off.
   */
  setAmbienceEnabled(on: boolean): void {
    this.ambience = on
    for (const b of this.beds) b.apply()
  }

  get ambienceOn(): boolean {
    return this.ambience
  }

  /** Scale applied to every sustained bed. 0 when ambience is off. */
  get bedScale(): number {
    return this.ambience ? AMBIENCE_TRIM : 0
  }

  setVolume(bus: BusName, v: number): void {
    this.volumes[bus] = v
    const g = this.buses[bus]
    if (g) g.gain.value = v
  }

  private buildNoise(): void {
    if (!this.ctx) return
    const len = Math.floor(this.ctx.sampleRate * 2)
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
    const data = buf.getChannelData(0)
    // Slightly pink-tinted noise: less harsh than pure white for water and wind.
    let last = 0
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1
      last = (last + 0.035 * white) / 1.035
      data[i] = last * 3.2
    }
    this.noiseBuffer_ = buf
  }

  /** A pitched note or sweep. */
  tone(spec: ToneSpec): void {
    const ctx = this.ctx
    const bus = this.buses[spec.bus ?? 'sfx']
    if (!ctx || !bus || this.muted) return
    const peak = spec.gain ?? 0.3
    // A request for silence is not an error; it is just nothing to play.
    if (!(peak > MIN_GAIN)) return
    const t0 = ctx.currentTime + (spec.delay ?? 0)
    const dur = Math.max(0.01, spec.duration)
    const attack = Math.min(spec.attack ?? 0.005, dur * 0.5)

    const env = ctx.createGain()
    env.gain.setValueAtTime(MIN_GAIN, t0)
    env.gain.exponentialRampToValueAtTime(peak, t0 + attack)
    env.gain.exponentialRampToValueAtTime(MIN_GAIN, t0 + dur)
    env.connect(bus)

    const makeOsc = (detuneCents: number): void => {
      const osc = ctx.createOscillator()
      osc.type = spec.type ?? 'sine'
      osc.detune.value = detuneCents
      osc.frequency.setValueAtTime(spec.freq, t0)
      if (spec.toFreq !== undefined && spec.toFreq !== spec.freq) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, spec.toFreq), t0 + dur)
      }
      osc.connect(env)
      osc.start(t0)
      osc.stop(t0 + dur + 0.02)
    }
    makeOsc(0)
    if (spec.detune) makeOsc(spec.detune)
  }

  /** Filtered noise: whooshes, splashes, gravel, wind, crowd. */
  noise(spec: NoiseSpec): void {
    const ctx = this.ctx
    const bus = this.buses[spec.bus ?? 'sfx']
    if (!ctx || !bus || !this.noiseBuffer_ || this.muted) return
    const peak = spec.gain ?? 0.25
    if (!(peak > MIN_GAIN)) return
    const t0 = ctx.currentTime + (spec.delay ?? 0)
    const dur = Math.max(0.01, spec.duration)
    const attack = Math.min(spec.attack ?? 0.008, dur * 0.5)

    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuffer_
    src.loop = true
    // Random offset so repeated hits never phase-align into a recognisable loop.
    const offset = Math.random() * (this.noiseBuffer_.duration - dur - 0.05)

    const filter = ctx.createBiquadFilter()
    filter.type = spec.q && spec.q > 1 ? 'bandpass' : 'lowpass'
    filter.Q.value = spec.q ?? 0.8
    const c0 = spec.cutoff ?? 2200
    filter.frequency.setValueAtTime(c0, t0)
    if (spec.toCutoff !== undefined && spec.toCutoff !== c0) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(40, spec.toCutoff), t0 + dur)
    }

    const env = ctx.createGain()
    env.gain.setValueAtTime(MIN_GAIN, t0)
    env.gain.exponentialRampToValueAtTime(peak, t0 + attack)
    env.gain.exponentialRampToValueAtTime(MIN_GAIN, t0 + dur)

    src.connect(filter)
    filter.connect(env)
    env.connect(bus)
    src.start(t0, Math.max(0, offset), dur + 0.05)
    src.stop(t0 + dur + 0.05)
  }

  /**
   * A sustained looping voice (wind, wave rumble, crowd bed) the caller controls.
   * Returns a handle; call `stop()` to fade it out.
   */
  loopNoise(opts: { cutoff?: number; q?: number; gain?: number; bus?: BusName } = {}): { setGain(v: number): void; setCutoff(hz: number): void; stop(fade?: number): void } {
    const ctx = this.ctx
    const bus = this.buses[opts.bus ?? 'sfx']
    if (!ctx || !bus || !this.noiseBuffer_) {
      /*
       * Audio unlocks on the first gesture, but a scene builds before that —
       * always for the first scene, and for every scene when a `?scene=` deep
       * link is used. This used to return a no-op, so those beds were silent
       * for the life of the scene and nobody noticed, because nobody in this
       * project ever listened. Defer instead: remember what was asked for and
       * build it when `unlock()` runs.
       */
      let want = opts.gain ?? 0.1
      let cutoff = opts.cutoff ?? 900
      let live: ReturnType<AudioBus['loopNoise']> | null = null
      let dead = false
      const pending = {
        materialise: (): void => {
          if (dead) return
          live = this.loopNoise({ ...opts, gain: want, cutoff })
        },
      }
      this.pendingBeds.add(pending)
      return {
        setGain: (v: number) => { want = v; live?.setGain(v) },
        setCutoff: (hz: number) => { cutoff = hz; live?.setCutoff(hz) },
        stop: (fade = 0.25) => {
          dead = true
          this.pendingBeds.delete(pending)
          live?.stop(fade)
        },
      }
    }
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuffer_
    src.loop = true
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.Q.value = opts.q ?? 0.7
    filter.frequency.value = opts.cutoff ?? 900
    const env = ctx.createGain()
    // `want` is what the scene asked for; what is heard is that times the
    // ambience trim, so the switch and the trim both work without every event
    // knowing about either.
    let want = opts.gain ?? 0.1
    env.gain.value = Math.max(0.0001, want * this.bedScale)
    src.connect(filter)
    filter.connect(env)
    env.connect(bus)
    src.start(ctx.currentTime, Math.random() * 1.5)
    let stopped = false
    const bed = {
      apply: (): void => {
        if (!stopped) env.gain.setTargetAtTime(Math.max(0.0001, want * this.bedScale), ctx.currentTime, 0.12)
      },
    }
    this.beds.add(bed)
    return {
      setGain: (v: number) => {
        want = v
        bed.apply()
      },
      setCutoff: (hz: number) => {
        if (!stopped) filter.frequency.setTargetAtTime(Math.max(40, hz), ctx.currentTime, 0.08)
      },
      stop: (fade = 0.25) => {
        if (stopped) return
        stopped = true
        this.beds.delete(bed)
        const now = ctx.currentTime
        env.gain.setTargetAtTime(0.0001, now, fade / 3)
        src.stop(now + fade + 0.1)
      },
    }
  }

  /**
   * Measure the master output.
   *
   * Audio is the one part of this project that was never verified, because the
   * whole review pipeline is screenshots and nobody could hear anything. This
   * makes it checkable: run it, and a tonal bed shows a handful of sharp
   * spectral peaks at note frequencies, while broadband noise shows energy
   * smeared across every bin. It is not a substitute for listening — it cannot
   * tell you whether a tune is any good — but it does distinguish music from
   * hiss, and silence from both.
   */
  async probe(ms = 700): Promise<{ rms: number; peaks: { hz: number; db: number }[]; flatness: number }> {
    const ctx = this.ctx
    if (!ctx || !this.master) return { rms: 0, peaks: [], flatness: 1 }
    const an = ctx.createAnalyser()
    an.fftSize = 4096
    an.smoothingTimeConstant = 0
    this.master.connect(an)
    const freq = new Float32Array(an.frequencyBinCount)
    const time = new Float32Array(an.fftSize)
    const peak = new Float32Array(an.frequencyBinCount).fill(-Infinity)
    let rms = 0
    let n = 0
    const started = performance.now()
    while (performance.now() - started < ms) {
      await new Promise((r) => setTimeout(r, 25))
      an.getFloatFrequencyData(freq)
      an.getFloatTimeDomainData(time)
      let sum = 0
      for (let i = 0; i < time.length; i++) sum += time[i] * time[i]
      rms += Math.sqrt(sum / time.length)
      n++
      for (let i = 0; i < freq.length; i++) if (freq[i] > peak[i]) peak[i] = freq[i]
    }
    this.master.disconnect(an)
    const binHz = ctx.sampleRate / an.fftSize

    // Spectral flatness over the musical range: geometric mean / arithmetic
    // mean of magnitudes. Near 1 is noise-like, near 0 is tonal.
    const lo = Math.floor(60 / binHz)
    const hi = Math.floor(6000 / binHz)
    let logSum = 0
    let linSum = 0
    let count = 0
    for (let i = lo; i < hi; i++) {
      const mag = Math.pow(10, peak[i] / 20) + 1e-12
      logSum += Math.log(mag)
      linSum += mag
      count++
    }
    const flatness = count > 0 ? Math.exp(logSum / count) / (linSum / count) : 1

    // Local maxima, strongest first.
    const peaks: { hz: number; db: number }[] = []
    for (let i = lo + 1; i < hi - 1; i++) {
      if (peak[i] > peak[i - 1] && peak[i] >= peak[i + 1] && peak[i] > -70) {
        peaks.push({ hz: Math.round(i * binHz), db: Math.round(peak[i] * 10) / 10 })
      }
    }
    peaks.sort((a, b) => b.db - a.db)
    return { rms: n > 0 ? rms / n : 0, peaks: peaks.slice(0, 8), flatness: Math.round(flatness * 1000) / 1000 }
  }

  /** Stop everything abruptly, e.g. on scene change. */
  panic(): void {
    if (!this.ctx || !this.master) return
    const now = this.ctx.currentTime
    this.master.gain.cancelScheduledValues(now)
    this.master.gain.setValueAtTime(0.0001, now)
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.masterVolume, now + 0.05, 0.04)
  }
}
