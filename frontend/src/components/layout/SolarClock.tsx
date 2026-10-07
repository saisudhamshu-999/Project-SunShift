import { useEffect, useRef, useState } from 'react'
import { usePlan } from '@/state/plan'

/** Fixed HUD: page scroll is the day at Feeder 07, from dawn (06:00) to dusk (18:00). */
export function SolarClock() {
  const [p, setP] = useState(0)
  const raf = useRef(0)
  const loc = usePlan((s) => s.result?.meta.location)
  useEffect(() => {
    const update = () => {
      raf.current = 0
      const max = document.documentElement.scrollHeight - window.innerHeight
      setP(max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0)
    }
    const on = () => {
      if (!raf.current) raf.current = requestAnimationFrame(update)
    }
    update()
    window.addEventListener('scroll', on, { passive: true })
    window.addEventListener('resize', on)
    return () => {
      window.removeEventListener('scroll', on)
      window.removeEventListener('resize', on)
      cancelAnimationFrame(raf.current)
    }
  }, [])
  const minutes = 6 * 60 + p * 12 * 60
  const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(Math.floor(minutes % 60)).padStart(2, '0')}`
  const angle = Math.PI * (1 - p)
  const cx = 34 + 26 * Math.cos(angle)
  const cy = 34 - 26 * Math.sin(angle)
  const lat = loc ? `${loc.lat.toFixed(2)}°N ${loc.lon.toFixed(2)}°E` : '17.97°N 79.59°E'
  return (
    <div data-nav aria-hidden className="pointer-events-none fixed bottom-4 left-[var(--gutter)] z-40 hidden items-end gap-3 mix-blend-difference text-ivory md:flex">
      <svg width="68" height="40" viewBox="0 0 68 40">
        <path d="M8 34a26 26 0 0 1 52 0" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1" />
        {Array.from({ length: 13 }, (_, i) => {
          const a = Math.PI * (1 - i / 12)
          return <line key={i} x1={34 + 23 * Math.cos(a)} y1={34 - 23 * Math.sin(a)} x2={34 + 26 * Math.cos(a)} y2={34 - 26 * Math.sin(a)} stroke="currentColor" strokeOpacity="0.55" />
        })}
        <line x1="2" y1="34.5" x2="66" y2="34.5" stroke="currentColor" strokeOpacity="0.5" />
        <circle cx={cx} cy={cy} r="3.6" fill="#f2a900" />
      </svg>
      <div className="mono pb-0.5 text-[10.5px] leading-[1.35] tracking-[0.12em] uppercase">
        <div className="num text-[13px] tracking-[0.06em]">{time}</div>
        <div className="opacity-70">Feeder 07 · {lat}</div>
      </div>
    </div>
  )
}
