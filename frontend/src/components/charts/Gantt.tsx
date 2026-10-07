import type { CropKey } from '@/api/types'
import { contiguousBlocks } from '@/engine/scenario'
import { clockFromSlot } from '@/lib/format'
import { CROP_COLOR, CROP_TAG } from '@/lib/palette'

export interface GanttRow {
  id: number
  code: string
  crop: CropKey
  slots: number[]
  /** Slots whose delivery was curtailed (shown hatched red). */
  overloaded?: Set<number>
  /** Slots cancelled by a re-plan (shown struck through). */
  cancelled?: number[]
  note?: string
}

/** Pump timeline: one row per farm, 48 × 15-minute slots from 06:00 to 18:00. */
export function Gantt({
  rows,
  slots = 48,
  cursor = null,
  fixedUntil = 0,
  selected = null,
  onSelect,
  barColor = 'var(--color-water)',
  rowHeight = 20,
  compact = false,
  label,
}: {
  rows: GanttRow[]
  slots?: number
  cursor?: number | null
  fixedUntil?: number
  selected?: number | null
  onSelect?: (id: number) => void
  barColor?: string
  rowHeight?: number
  compact?: boolean
  label: string
}) {
  const pct = (s: number) => `${(s / slots) * 100}%`
  return (
    <div role="group" aria-label={label} className="w-full">
      <div className="relative ml-[64px] h-5" aria-hidden>
        {[6, 8, 10, 12, 14, 16, 18].map((hh) => (
          <span key={hh} className="num absolute -translate-x-1/2 text-[10.5px] opacity-55" style={{ left: pct(((hh - 6) * 60) / 15) }}>
            {String(hh).padStart(2, '0')}
          </span>
        ))}
      </div>
      <div className="relative">
        <div className="pointer-events-none absolute inset-y-0 left-[64px] right-0" aria-hidden>
          {Array.from({ length: 13 }, (_, i) => (
            <span key={i} className="absolute inset-y-0 w-px" style={{ left: pct(i * 4), background: 'var(--line)', opacity: i % 2 ? 0.6 : 1 }} />
          ))}
          {fixedUntil > 0 && <span className="absolute inset-y-0 left-0" style={{ width: pct(fixedUntil), background: 'var(--fg)', opacity: 0.05 }} />}
          {cursor != null && <span className="absolute inset-y-0 w-px bg-sun" style={{ left: pct(cursor + 0.5) }} />}
        </div>
        <ul className="relative space-y-1">
          {rows.map((row) => {
            const blocks = contiguousBlocks(row.slots)
            const cancelled = contiguousBlocks(row.cancelled ?? [])
            const active = selected === row.id
            const window = blocks.map(([a, b]) => `${clockFromSlot(a)}–${clockFromSlot(b + 1)}`).join(', ') || 'no irrigation'
            return (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={onSelect ? () => onSelect(row.id) : undefined}
                  disabled={!onSelect}
                  aria-pressed={onSelect ? active : undefined}
                  aria-label={`${row.code} ${row.crop}: ${window}${row.note ? `. ${row.note}` : ''}`}
                  className={`group flex w-full items-center text-left ${onSelect ? 'cursor-pointer' : 'cursor-default'}`}
                  style={{ height: rowHeight }}
                >
                  <span className="flex w-[64px] shrink-0 items-center gap-1.5 pr-2">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: CROP_COLOR[row.crop] }} aria-hidden />
                    <span className={`num text-[11px] tracking-[0.04em] ${active ? 'font-[700]' : 'opacity-70'}`}>{row.code}</span>
                    {!compact && <span className="text-[9px] tracking-[0.1em] opacity-40">{CROP_TAG[row.crop]}</span>}
                  </span>
                  <span
                    className="relative h-full flex-1 rounded-[3px] transition-colors"
                    style={{ background: active ? 'color-mix(in srgb, var(--fg) 8%, transparent)' : undefined }}
                  >
                    {blocks.map(([a, b], i) => (
                      <span
                        key={i}
                        className="absolute top-[3px] bottom-[3px] rounded-[3px] transition-[left,width] duration-[900ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
                        style={{ left: pct(a), width: pct(b - a + 1), background: barColor, opacity: active || selected == null ? 1 : 0.55 }}
                      />
                    ))}
                    {row.overloaded &&
                      [...row.overloaded].map((s) => (
                        <span
                          key={`o${s}`}
                          className="absolute top-[3px] bottom-[3px]"
                          style={{ left: pct(s), width: pct(1), background: 'repeating-linear-gradient(45deg, #d04a2f 0 2px, transparent 2px 5px)' }}
                        />
                      ))}
                    {cancelled.map(([a, b], i) => (
                      <span
                        key={`c${i}`}
                        className="absolute top-[3px] bottom-[3px] rounded-[3px] border"
                        style={{ left: pct(a), width: pct(b - a + 1), borderColor: 'var(--fg-2)', borderStyle: 'dashed', background: 'repeating-linear-gradient(-45deg, transparent 0 4px, color-mix(in srgb, var(--fg) 18%, transparent) 4px 5px)' }}
                      />
                    ))}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
