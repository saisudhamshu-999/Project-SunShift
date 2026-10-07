import type { ReactNode } from 'react'

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#']

/** A plain feature phone: the farmer needs no app and no data plan. */
export function Phone({ screen, onKey, highlight = [], label }: { screen: ReactNode; onKey?: (k: string) => void; highlight?: string[]; label: string }) {
  return (
    <div className="mx-auto w-[min(300px,82vw)] select-none" aria-label={label} role="group">
      <div className="rounded-[46px] bg-graphite p-4 pb-6 shadow-[0_40px_80px_-30px_rgba(21,20,15,0.6),inset_0_1px_0_rgba(255,255,255,0.08)]">
        <div className="mx-auto mb-3 h-1.5 w-14 rounded-full bg-black/40" aria-hidden />
        <div className="relative h-[330px] overflow-hidden rounded-[18px] bg-[#e9ecdc] p-3 text-ink shadow-[inset_0_2px_10px_rgba(0,0,0,0.25)]">{screen}</div>
        <div className="mt-5 grid grid-cols-3 gap-2.5 px-2">
          {KEYS.map((k) => {
            const hot = highlight.includes(k)
            return (
              <button
                key={k}
                type="button"
                onClick={() => onKey?.(k)}
                aria-label={`Key ${k}`}
                className={`h-10 rounded-[14px] text-[17px] font-[600] transition-all duration-200 active:scale-95 ${hot ? 'bg-sun text-ink shadow-[0_0_0_3px_rgba(242,169,0,0.35)]' : 'bg-[#3a3833] text-ivory/90 hover:bg-[#46433d]'}`}
              >
                {k}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
