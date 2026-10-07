import { useEffect, useMemo, useRef, useState } from 'react'
import { callScript, LANGS, smsFor, strings, type Lang } from '@/components/farmer/messages'
import { Phone } from '@/components/farmer/Phone'
import { Reveal } from '@/components/text/Reveal'
import { SourceBadge } from '@/components/ui/SourceBadge'
import { ActLabel, Segmented } from '@/components/ui/primitives'
import { sound } from '@/lib/sound'
import { usePlan } from '@/state/plan'
import { useUi } from '@/state/ui'

type Mode = 'sms' | 'ringing' | 'call' | 'ended'
interface Bubble {
  from: 'them' | 'me'
  text: string
}

function speak(text: string, lang: string): boolean {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return false
  const voices = window.speechSynthesis.getVoices()
  const voice = voices.find((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()))
  if (!voice) return false
  const u = new SpeechSynthesisUtterance(text)
  u.voice = voice
  u.lang = voice.lang
  u.rate = 0.92
  window.speechSynthesis.speak(u)
  return true
}

const PRINCIPLES = [
  ['Actionable', 'One window, one action. No charts, no jargon.'],
  ['Low-literacy friendly', 'Times and numbers first, a voice call in the farmer\'s language, two-key replies.'],
  ['Low-connectivity friendly', 'Plain SMS and voice. No app, no data plan, no smartphone.'],
  ['Two-way', 'Replies feed straight back into the next re-optimisation.'],
]

export function Farmer() {
  const plan = usePlan((s) => s.result)
  const soundOn = useUi((s) => s.sound)
  const selected = useUi((s) => s.selectedFarm)
  const [lang, setLang] = useState<Lang>('te')
  const [farmId, setFarmId] = useState<number>(selected ?? 7)
  const [mode, setMode] = useState<Mode>('sms')
  const [thread, setThread] = useState<Bubble[]>([])
  const [captions, setCaptions] = useState<string[]>([])
  const [voiceNote, setVoiceNote] = useState<string | null>(null)
  const timers = useRef<number[]>([])

  useEffect(() => {
    void import('@fontsource/noto-sans-telugu/400.css')
    void import('@fontsource/noto-sans-devanagari/400.css')
    if ('speechSynthesis' in window) window.speechSynthesis.getVoices()
  }, [])

  const farm = plan?.farms.find((f) => f.id === farmId) ?? plan?.farms[6]
  const sms = useMemo(() => (farm ? smsFor(farm, lang) : null), [farm, lang])
  const t = strings(lang)
  const speechLang = LANGS.find((l) => l.id === lang)!.speech

  const clearTimers = () => {
    timers.current.forEach((id) => window.clearTimeout(id))
    timers.current = []
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
  }
  useEffect(() => {
    clearTimers()
    setMode('sms')
    setThread([])
    setCaptions([])
  }, [farmId, lang]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => clearTimers, [])

  const onKey = (k: string) => {
    sound.tick()
    if (!farm) return
    if (mode === 'sms' && sms?.actionable && (k === '1' || k === '2')) {
      const window_ = farm.schedule.window.split(',')[0]
      setThread([{ from: 'me', text: k }, { from: 'them', text: k === '1' ? t.confirmed(window_) : t.changeAsk }])
    }
    if (mode === 'call' && (k === '1' || k === '2')) {
      const line = k === '1' ? t.pressed1 : t.pressed2
      setCaptions((c) => [...c, `[${k}]`, line])
      if (soundOn) speak(line, speechLang)
      timers.current.push(window.setTimeout(() => setMode('ended'), 2600))
    }
  }

  const call = () => {
    if (!farm) return
    clearTimers()
    setCaptions([])
    setMode('ringing')
    sound.click()
    timers.current.push(
      window.setTimeout(() => {
        setMode('call')
        const lines = callScript(farm, lang)
        let spoke = false
        if (soundOn) {
          spoke = speak(lines.join(' '), speechLang)
          setVoiceNote(spoke ? null : `No ${LANGS.find((l) => l.id === lang)!.label} voice on this device: captions only.`)
        } else setVoiceNote('Sound is off: captions only. Turn sound on to hear the call.')
        lines.forEach((line, i) => timers.current.push(window.setTimeout(() => setCaptions((c) => [...c, line]), 300 + i * 1700)))
      }, 2200),
    )
  }

  const screen = !farm ? (
    <p className="kicker opacity-60">Waiting for today's plan…</p>
  ) : mode === 'ringing' ? (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <span className="grid h-16 w-16 animate-pulse place-items-center rounded-full bg-crop text-ivory">
        <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden>
          <path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.6 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.6 3.6a1 1 0 0 1-.25 1z" fill="currentColor" />
        </svg>
      </span>
      <p className="kicker">Incoming call</p>
      <p className={`text-[20px] font-[650] ${lang === 'en' ? '' : 'indic'}`}>{t.brand}</p>
      <p className="kicker text-[10px] opacity-60">Voice call · IVR</p>
    </div>
  ) : mode === 'call' || mode === 'ended' ? (
    <div className="flex h-full flex-col">
      <p className="kicker flex justify-between opacity-70">
        <span>{mode === 'ended' ? 'Call ended' : 'On call · SunShift'}</span>
        <span className="num">{captions.length ? `0:${String(Math.min(59, captions.length * 2)).padStart(2, '0')}` : '0:00'}</span>
      </p>
      <div className={`mt-3 flex-1 space-y-2 overflow-hidden text-[13.5px] leading-snug ${lang === 'en' ? '' : 'indic'}`} aria-live="polite">
        {captions.map((c, i) => (
          <p key={i} className={c.startsWith('[') ? 'kicker text-crop' : ''}>
            {c}
          </p>
        ))}
      </div>
    </div>
  ) : (
    <div className="flex h-full flex-col">
      <p className="kicker flex justify-between opacity-60">
        <span>Messages</span>
        <span className="num">06:30</span>
      </p>
      <div className={`mt-3 flex flex-1 flex-col gap-2 overflow-hidden text-[13px] leading-snug ${lang === 'en' ? '' : 'indic'}`}>
        {sms && (
          <div className="max-w-[92%] rounded-[12px] rounded-tl-[3px] bg-white px-3 py-2 shadow-sm">
            {sms.lines.map((l, i) => (
              <p key={i} className={i === 0 ? 'mb-1 text-[11px] font-[700] tracking-[0.06em]' : i === 1 ? 'text-[15px] font-[700]' : ''}>
                {l}
              </p>
            ))}
          </div>
        )}
        {thread.map((b, i) => (
          <div key={i} className={`max-w-[85%] rounded-[12px] px-3 py-2 ${b.from === 'me' ? 'self-end rounded-tr-[3px] bg-ink text-ivory' : 'rounded-tl-[3px] bg-white shadow-sm'}`}>
            {b.text}
          </div>
        ))}
      </div>
    </div>
  )

  return (
    <section id="farmer" className="relative overflow-hidden bg-sand py-[clamp(80px,11vw,170px)] text-ink" data-theme="light">
      <div className="wrap">
        <ActLabel act="VII" title="The farmer" />
        <h2 className="t-display t-xl mt-8">
          <Reveal as="span" className="block" split="words">
            Complex system.
          </Reveal>
          {' '}
          <Reveal as="span" className="block" split="words" delay={0.15}>
            Simple instruction.
          </Reveal>
        </h2>

        <div className="mt-16 grid items-start gap-12 lg:grid-cols-[1fr_auto_1fr]">
          <ul className="space-y-6 lg:pt-6">
            {PRINCIPLES.map(([k, v]) => (
              <li key={k} className="border-t pt-4" style={{ borderColor: 'var(--line-2)' }}>
                <p className="text-[19px] font-[620] tracking-[-0.02em]">{k}</p>
                <p className="mt-1 text-[14.5px] leading-relaxed opacity-70">{v}</p>
              </li>
            ))}
          </ul>

          <Phone
            screen={screen}
            onKey={onKey}
            highlight={(mode === 'sms' && sms?.actionable && !thread.length) || mode === 'call' ? ['1', '2'] : []}
            label={`Feature phone showing SunShift's ${mode === 'sms' ? 'SMS' : 'voice call'} for farm ${farm?.code ?? ''}`}
          />

          <div className="space-y-6 lg:pt-6">
            <div>
              <p className="kicker opacity-60">Language</p>
              <div className="mt-3">
                <Segmented<Lang> label="Message language" value={lang} onChange={setLang} options={LANGS.map((l) => ({ value: l.id, label: <span className={l.id === 'en' ? '' : 'indic normal-case tracking-normal'}>{l.native}</span> }))} />
              </div>
            </div>
            <label className="block">
              <span className="kicker opacity-60">Farm</span>
              <select className="mt-2 block w-full rounded-xl border bg-transparent px-3 py-2.5 text-[15px]" style={{ borderColor: 'var(--line-2)' }} value={farm?.id ?? 7} onChange={(e) => setFarmId(Number(e.target.value))}>
                {plan?.farms.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.code} · {f.cropLabel} · {f.schedule.window || (f.deferred ? 'rain: no irrigation' : 'no irrigation today')}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-wrap gap-3">
              <button className="btn btn-primary" onClick={call} disabled={!farm || mode === 'ringing'}>
                Call farmer
              </button>
              {mode !== 'sms' && (
                <button className="btn btn-ghost" onClick={() => (clearTimers(), setMode('sms'), setCaptions([]))}>
                  Back to SMS
                </button>
              )}
            </div>
            <p className="text-[14px] leading-relaxed opacity-70">
              {mode === 'sms'
                ? sms?.actionable
                  ? 'Press 1 or 2 on the keypad to reply, exactly as a farmer would.'
                  : 'When there is nothing to do, the message says so in one line.'
                : 'Voice calls (IVR) reach farmers who prefer listening to reading. Captions are always shown.'}
            </p>
            {voiceNote && mode !== 'sms' && <p className="kicker text-earth">{voiceNote}</p>}
            {mode !== 'sms' && captions.length > 0 && (
              <div className="card p-4" aria-label="Call transcript">
                <p className="kicker opacity-55">Transcript</p>
                <ol className={`mt-2 space-y-1 text-[14px] ${lang === 'en' ? '' : 'indic'}`}>
                  {captions.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ol>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <SourceBadge kind="simulation" />
              <span className="chip">Message built from today's plan</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
