import { useId, useState, type ReactNode } from 'react'
import { sound } from '@/lib/sound'

export function ActLabel({ act, title, className = '' }: { act: string; title: string; className?: string }) {
  return (
    <div className={`flex items-center gap-3 kicker ${className}`}>
      <span className="text-sun">Act {act}</span>
      <span className="h-px w-10 bg-current opacity-30" aria-hidden />
      <span className="opacity-70">{title}</span>
    </div>
  )
}

export function Stat({ label, value, unit, sub, accent }: { label: string; value: ReactNode; unit?: string; sub?: ReactNode; accent?: string }) {
  return (
    <div className="min-w-0">
      <p className="kicker opacity-60">{label}</p>
      <p className="num mt-2 text-[clamp(1.6rem,2.6vw,2.4rem)] font-[600] leading-none tracking-[-0.03em]" style={accent ? { color: accent } : undefined}>
        {value}
        {unit && <span className="ml-1 text-[0.5em] font-[500] tracking-normal opacity-60">{unit}</span>}
      </p>
      {sub && <p className="mt-1.5 text-[13px] opacity-60">{sub}</p>}
    </div>
  )
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  size = 'md',
}: {
  options: { value: T; label: ReactNode }[]
  value: T
  onChange: (v: T) => void
  label: string
  size?: 'sm' | 'md'
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap rounded-full border p-1" style={{ borderColor: 'var(--line-2)' }}>
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={active}
            onClick={() => {
              sound.tick()
              onChange(o.value)
            }}
            className={`rounded-full kicker transition-colors duration-300 ${size === 'sm' ? 'px-3 py-1.5' : 'px-4 py-2.5'} ${active ? 'bg-[var(--fg)] text-[var(--bg)]' : 'hover:bg-current/10'}`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
  format,
  hint,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  onChange: (v: number) => void
  format?: (v: number) => string
  hint?: string
}) {
  const id = useId()
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="kicker opacity-70">
          {label}
        </label>
        <span className="num text-[15px] font-[560]">
          {format ? format(value) : value}
          {unit && <span className="ml-1 text-[12px] opacity-60">{unit}</span>}
        </span>
      </div>
      <input id={id} type="range" className="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      {hint && <p className="text-[12px] opacity-55">{hint}</p>}
    </div>
  )
}

export function Disclosure({ summary, children, defaultOpen = false }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  return (
    <div className="border-t" style={{ borderColor: 'var(--line)' }}>
      <button aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-4 py-4 text-left">
        <span className="kicker">{summary}</span>
        <span aria-hidden className="text-lg transition-transform duration-300" style={{ transform: open ? 'rotate(45deg)' : 'none' }}>
          +
        </span>
      </button>
      <div id={id} hidden={!open} className="pb-6">
        {children}
      </div>
    </div>
  )
}

export function Meter({
  value,
  max,
  color = 'var(--fg)',
  label,
  markers = [],
}: {
  value: number
  max: number
  color?: string
  label?: string
  markers?: { at: number; label: string }[]
}) {
  const share = Math.max(0, Math.min(1, max > 0 ? value / max : 0))
  return (
    <div
      className="relative h-2.5 w-full rounded-full"
      style={{ background: 'var(--line)' }}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.round(value * 10) / 10}
      aria-label={label}
    >
      <div className="h-full rounded-full transition-[width] duration-700 ease-out" style={{ width: `${share * 100}%`, background: color }} />
      {markers.map((m) => (
        <span key={m.label} className="absolute -top-1 h-[18px] w-px" style={{ left: `${(m.at / max) * 100}%`, background: 'var(--fg)' }} title={m.label} />
      ))}
    </div>
  )
}

/** Small "solver is working" indicator. */
export function Working({ label = 'Solving' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 kicker" role="status" aria-live="polite">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sun opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-sun" />
      </span>
      {label}
    </span>
  )
}
