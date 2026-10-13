import { useEffect, useState } from 'react'
import * as api from '@/api/client'
import type { MessageRow } from '@/api/types'

const STATUS: Record<MessageRow['status'], { label: string; color: string }> = {
  simulated: { label: 'Simulated', color: '#a59d8a' },
  sent: { label: 'Sent', color: '#84b85c' },
  failed: { label: 'Failed', color: '#ef8a6c' },
  received: { label: 'Reply', color: '#6aa8e6' },
}

/** The farmer SMS log: what was sent, and what farmers replied. Phone numbers never reach the browser. */
export function MessageLog() {
  const [rows, setRows] = useState<MessageRow[] | null>(null)
  useEffect(() => {
    let alive = true
    const load = () => void api.messages(20).then((r) => alive && setRows(r))
    load()
    const id = window.setInterval(load, 20000)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [])
  const simulated = rows?.some((r) => r.provider === 'simulated')

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="kicker text-ivory/50">Farmer messages</p>
        {simulated && <span className="chip" style={{ borderStyle: 'dashed' }}>Simulated gateway · nothing sent</span>}
      </div>
      {!rows?.length ? (
        <p className="mt-2 text-[13px] text-ivory/55">
          No messages yet. Farmers with a phone number and opt-in get their window when the day is dispatched (POST /api/dispatch); their
          replies (1 = OK, 2 = change time, 0 = not today) re-plan the feeder.
        </p>
      ) : (
        <ol className="mt-3 max-h-[320px] space-y-2.5 overflow-y-auto pr-1" data-lenis-prevent>
          {rows.map((m) => (
            <li key={m.id} className={`rounded-xl p-3 text-[12.5px] ${m.direction === 'in' ? 'ml-6 bg-water/15' : 'mr-6 bg-ivory/[0.06]'}`}>
              <p className="kicker flex justify-between gap-2 text-ivory/50">
                <span>
                  {m.direction === 'in' ? '←' : '→'} {m.code ?? 'unknown sender'} · {m.language.toUpperCase()}
                </span>
                <span style={{ color: STATUS[m.status].color }}>
                  {STATUS[m.status].label} · {new Date(m.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </p>
              <p className="indic mt-1 whitespace-pre-line text-ivory/80">{m.body}</p>
              {m.error && <p className="mt-1 text-[#ef8a6c]">{m.error}</p>}
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
