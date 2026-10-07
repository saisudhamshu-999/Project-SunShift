import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { useUi } from '@/state/ui'
import { Logo } from './Logo'
import { scrollToTarget } from './SmoothScroll'

const LINKS = [
  { id: 'story', label: 'Story' },
  { id: 'system', label: 'System' },
  { id: 'simulation', label: 'Simulation' },
  { id: 'impact', label: 'Impact' },
]

function SoundIcon({ on }: { on: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M2.5 6v4h2.5l3.5 3V3L5 6z" fill="currentColor" stroke="none" />
      {on ? (
        <>
          <path d="M10.5 5.5a3.5 3.5 0 0 1 0 5" />
          <path d="M12.5 3.5a6.3 6.3 0 0 1 0 9" />
        </>
      ) : (
        <path d="M10.5 6l4 4m0-4l-4 4" />
      )}
    </svg>
  )
}

function MotionIcon({ reduced }: { reduced: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M1.5 8h3m2 0h2m2 0h4" opacity={reduced ? 1 : 0.35} />
      {!reduced && <path d="M1.5 8c2-4 4-4 6.5 0s4.5 4 6.5 0" />}
    </svg>
  )
}

export function Nav() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { sound, toggleSound, reducedMotion, setReducedMotion, apiStatus } = useUi()
  const [dark, setDark] = useState(false)
  const [open, setOpen] = useState(false)
  const onHome = pathname === '/'

  // Match the nav to whatever scene sits under it.
  useEffect(() => {
    let raf = 0
    const check = () => {
      raf = 0
      const els = document.elementsFromPoint(window.innerWidth / 2, 32)
      const under = els.find((el) => !el.closest('[data-nav]'))
      setDark(under?.closest('[data-theme]')?.getAttribute('data-theme') === 'dark')
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(check)
    }
    check()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    const id = window.setInterval(check, 1200)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      window.clearInterval(id)
      cancelAnimationFrame(raf)
    }
  }, [pathname])

  useEffect(() => setOpen(false), [pathname])

  const go = (id: string) => {
    setOpen(false)
    if (onHome) scrollToTarget(`#${id}`)
    else navigate(`/#${id}`)
  }

  const fg = dark ? 'text-ivory' : 'text-ink'
  const engineChip =
    apiStatus === 'online' ? (
      <span className="chip hidden xl:inline-flex" title="Schedules are solved by OR-Tools CP-SAT on the SunShift API">
        <span className="h-1.5 w-1.5 rounded-full bg-crop" aria-hidden /> CP-SAT online
      </span>
    ) : apiStatus === 'offline' ? (
      <span className="chip hidden xl:inline-flex" title="API unreachable: schedules come from the in-browser heuristic">
        <span className="h-1.5 w-1.5 rounded-full bg-alert" aria-hidden /> Browser fallback
      </span>
    ) : null

  return (
    <>
      <a href="#main" className="sr-only-focusable fixed left-4 top-4 z-[80] rounded-full bg-sun px-4 py-2 text-ink">
        Skip to content
      </a>
      <header data-nav className={`fixed inset-x-0 top-0 z-50 transition-colors duration-500 ${fg}`}>
        <div className="wrap flex h-[var(--nav-h)] items-center justify-between gap-4">
          <Link to="/" aria-label="SunShift home" className="shrink-0">
            <Logo />
          </Link>

          <nav aria-label="Sections" className="hidden items-center gap-1 rounded-full px-1.5 py-1 lg:flex" style={{ background: dark ? 'rgb(243 238 228 / 0.08)' : 'rgb(21 20 15 / 0.05)', backdropFilter: 'blur(14px)' }}>
            {LINKS.map((l) => (
              <button key={l.id} onClick={() => go(l.id)} className="kicker rounded-full px-3.5 py-2 transition-colors hover:bg-current/10">
                {l.label}
              </button>
            ))}
          </nav>

          <div className="flex items-center gap-2">
            {engineChip}
            <button
              onClick={toggleSound}
              aria-pressed={sound}
              aria-label={sound ? 'Turn sound off' : 'Turn sound on'}
              className="hidden h-9 items-center gap-1.5 rounded-full px-3 kicker transition-colors hover:bg-current/10 sm:inline-flex"
            >
              <SoundIcon on={sound} />
              <span className="hidden lg:inline">{sound ? 'Sound on' : 'Sound off'}</span>
            </button>
            <button
              onClick={() => setReducedMotion(!reducedMotion)}
              aria-pressed={reducedMotion}
              aria-label={reducedMotion ? 'Enable full motion' : 'Reduce motion'}
              className="hidden h-9 items-center gap-1.5 rounded-full px-3 kicker transition-colors hover:bg-current/10 sm:inline-flex"
            >
              <MotionIcon reduced={reducedMotion} />
              <span className="hidden lg:inline">{reducedMotion ? 'Motion reduced' : 'Reduce motion'}</span>
            </button>
            <Link
              to="/app"
              className={`btn hidden h-10 shrink-0 whitespace-nowrap px-4 text-[14px] sm:inline-flex ${dark ? 'bg-ivory text-ink' : 'bg-ink text-ivory'}`}
            >
              <span className="xl:hidden">Live feeder</span>
              <span className="hidden xl:inline">Launch live feeder</span> <span aria-hidden>→</span>
            </Link>
            <button
              className="inline-flex h-10 w-10 items-center justify-center rounded-full lg:hidden"
              aria-label="Open menu"
              aria-expanded={open}
              onClick={() => setOpen(true)}
            >
              <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
                <path d="M3 7h14M3 13h14" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      {open && (
        <div role="dialog" aria-modal="true" aria-label="Menu" className="fixed inset-0 z-[70] flex flex-col bg-ink text-ivory" data-theme="dark">
          <div className="wrap flex h-[var(--nav-h)] items-center justify-between">
            <Logo />
            <button className="h-10 w-10 rounded-full" aria-label="Close menu" onClick={() => setOpen(false)}>
              <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="mx-auto">
                <path d="M5 5l10 10M15 5L5 15" />
              </svg>
            </button>
          </div>
          <div className="wrap flex flex-1 flex-col justify-center gap-2">
            {LINKS.map((l, i) => (
              <button key={l.id} onClick={() => go(l.id)} className="t-display t-l text-left">
                <span className="kicker mr-4 align-top text-sun">0{i + 1}</span>
                {l.label}
              </button>
            ))}
            <Link to="/app" className="t-display t-l text-left text-sun">Live feeder →</Link>
            <Link to="/demo" className="t-display t-m mt-2 text-left opacity-70">Demo mode →</Link>
          </div>
          <div className="wrap flex gap-2 pb-8">
            <button onClick={toggleSound} aria-pressed={sound} className="btn btn-ghost h-10 flex-1">
              <SoundIcon on={sound} /> {sound ? 'Sound on' : 'Sound off'}
            </button>
            <button onClick={() => setReducedMotion(!reducedMotion)} aria-pressed={reducedMotion} className="btn btn-ghost h-10 flex-1">
              <MotionIcon reduced={reducedMotion} /> {reducedMotion ? 'Motion reduced' : 'Reduce motion'}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
