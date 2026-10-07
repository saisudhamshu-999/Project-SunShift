import type { PlanResult } from '@/api/types'
import { usePlan } from '@/state/plan'
import { SourceBadge } from './SourceBadge'
import { Working } from './primitives'

/** Honest provenance for whatever plan is on screen. */
export function PlanBadges({ plan, className = '' }: { plan: PlanResult | null; className?: string }) {
  const engine = usePlan((s) => s.engine)
  if (!plan) return null
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <SourceBadge kind="simulation" />
      <SourceBadge kind={plan.meta.sources.weather} />
      <SourceBadge kind={engine === 'heuristic' || plan.meta.engine === 'heuristic' ? 'heuristic' : 'cp-sat'} />
    </div>
  )
}

export function PlanLoading({ label = 'Planning today on Feeder 07' }: { label?: string }) {
  const status = usePlan((s) => s.status)
  const error = usePlan((s) => s.error)
  const run = usePlan((s) => s.run)
  if (status === 'error')
    return (
      <div className="flex items-center gap-3 kicker">
        <span className="text-alert">Plan failed: {error}</span>
        <button className="underline" onClick={() => void run()}>
          Retry
        </button>
      </div>
    )
  return <Working label={label} />
}
