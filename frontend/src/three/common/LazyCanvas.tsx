import { Canvas, useFrame, useThree, type CanvasProps } from '@react-three/fiber'
import { Component, Suspense, useEffect, useRef, useState, type ReactNode } from 'react'
import { deviceTier, webglAvailable, type Tier } from '@/lib/device'
import { useInView } from '@/lib/hooks'

class GlBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(err: unknown) {
    console.warn('3D scene failed, showing fallback', err)
    this.props.onError()
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

/** Reports once the scene has rendered a few frames (shaders compiled, geometry built). */
function ReadySignal({ onReady }: { onReady: () => void }) {
  const frames = useRef(0)
  const done = useRef(false)
  useFrame(() => {
    if (done.current) return
    frames.current += 1
    if (frames.current >= 3) {
      done.current = true
      onReady()
    }
  })
  return null
}

/**
 * Drives this canvas from its own requestAnimationFrame loop instead of R3F's shared one.
 * R3F's loop is module-level: if a page loads hidden (a background tab), it can end up
 * flagged as running with no frame pending and never restart. Driving each root
 * directly avoids that, and lets offscreen scenes stop rendering entirely.
 */
function FrameDriver({ active }: { active: boolean }) {
  const advance = useThree((s) => s.advance)
  const clock = useThree((s) => s.clock)
  useEffect(() => {
    if (!active) return
    let raf = 0
    // R3F stores this timestamp as clock.elapsedTime, which is in seconds; rAF gives milliseconds.
    const tick = (t: number) => {
      advance(t / 1000, true)
      raf = requestAnimationFrame(tick)
    }
    // Start (or resume after being offscreen/hidden) without one huge catch-up delta.
    const start = () => {
      clock.elapsedTime = performance.now() / 1000
      raf = requestAnimationFrame(tick)
    }
    start()
    // Dev-only: let automated checks read scene time.
    if (import.meta.env.DEV) ((window as unknown as { __clocks?: Set<typeof clock> }).__clocks ??= new Set()).add(clock)
    const onVisibility = () => {
      cancelAnimationFrame(raf)
      if (!document.hidden) start()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [active, advance, clock])
  return null
}

export interface LazyCanvasProps extends Omit<CanvasProps, 'children' | 'fallback'> {
  children: (tier: Tier) => ReactNode
  fallback: ReactNode
  label: string
  className?: string
  /** Keep the GL context alive once created (pinned scenes). */
  keepAlive?: boolean
  margin?: string
}

/**
 * Mounts a WebGL canvas only near the viewport, renders it only while visible (or while
 * warming up), unmounts it when far away, keeps the fallback visible until the first
 * frames have rendered, and shows the fallback for good when WebGL is missing or fails.
 */
export function LazyCanvas({ children, fallback, label, className = '', keepAlive = false, margin = '700px 0px', ...canvas }: LazyCanvasProps) {
  const ref = useRef<HTMLDivElement>(null)
  const near = useInView(ref, { margin })
  const visible = useInView(ref, { margin: '80px 0px' })
  const [mounted, setMounted] = useState(false)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [tier] = useState<Tier>(() => deviceTier())
  const supported = typeof window !== 'undefined' && webglAvailable()

  useEffect(() => {
    if (near) {
      setMounted(true)
      return
    }
    if (keepAlive) return
    const id = window.setTimeout(() => {
      setMounted(false)
      setReady(false)
    }, 5000)
    return () => window.clearTimeout(id)
  }, [near, keepAlive])

  const showGl = supported && !failed && mounted
  const veil = !showGl || !ready || !visible
  return (
    <div ref={ref} className={/\b(absolute|fixed|sticky)\b/.test(className) ? className : `relative ${className}`} role="img" aria-label={label}>
      {showGl && (
        <GlBoundary onError={() => setFailed(true)}>
          <Canvas
            frameloop="never"
            dpr={tier === 'high' ? [1, 1.75] : tier === 'mid' ? [1, 1.4] : [1, 1.15]}
            gl={{ antialias: tier !== 'low', powerPreference: 'high-performance', alpha: false }}
            style={{ position: 'absolute', inset: 0 }}
            {...canvas}
          >
            <FrameDriver active={visible || !ready} />
            <Suspense fallback={null}>
              {children(tier)}
              <ReadySignal onReady={() => setReady(true)} />
            </Suspense>
          </Canvas>
        </GlBoundary>
      )}
      <div className={`pointer-events-none absolute inset-0 transition-opacity duration-700 ${veil ? 'opacity-100' : 'opacity-0'}`} aria-hidden={!veil}>
        {fallback}
        {showGl && !ready && (
          <span className="kicker absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink/70 px-3 py-1.5 text-ivory">Building the scene…</span>
        )}
      </div>
    </div>
  )
}
