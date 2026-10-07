export function LogoMark({ size = 26, sun = '#f2a900', ink = 'currentColor' }: { size?: number; sun?: string; ink?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <path d="M6 21.5a10 10 0 0 1 20 0" fill="none" stroke={ink} strokeWidth="2.4" strokeLinecap="round" />
      <path d="M3.5 25.5h25" stroke={ink} strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="21.6" cy="13.4" r="3.3" fill={sun} />
    </svg>
  )
}

export function Logo({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark />
      <span className="text-[15px] font-[680] tracking-[0.18em]">SUNSHIFT</span>
    </span>
  )
}
