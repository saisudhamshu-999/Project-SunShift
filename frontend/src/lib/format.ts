// Numbers are formatted with Indian digit grouping (1,00,000).
const nf = new Map<number, Intl.NumberFormat>()

export function fmt(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return '–'
  let f = nf.get(digits)
  if (!f) {
    f = new Intl.NumberFormat('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    nf.set(digits, f)
  }
  return f.format(n)
}

export const pct = (x: number | null | undefined, digits = 0) => (x == null || !Number.isFinite(x) ? '–' : `${fmt(x * 100, digits)}%`)
export const kw = (x: number, digits = 1) => `${fmt(x, digits)} kW`
export const kwh = (x: number, digits = 0) => `${fmt(x, digits)} kWh`
export const m3 = (x: number, digits = 0) => `${fmt(x, digits)} m³`
export const litres = (m3v: number) => `${fmt(Math.round(m3v * 1000))} L`

export function slotTime(slot: number, dayStartHour = 6, slotMinutes = 15): string {
  const minutes = dayStartHour * 60 + slot * slotMinutes
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(Math.round(minutes % 60)).padStart(2, '0')}`
}

/** Fractional slot (e.g. 23.4) to clock time. */
export function clockFromSlot(slot: number, dayStartHour = 6, slotMinutes = 15): string {
  const minutes = Math.max(0, Math.round(dayStartHour * 60 + slot * slotMinutes))
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

export const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a))
  return t * t * (3 - 2 * t)
}
