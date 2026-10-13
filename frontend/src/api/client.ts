import type {
  FairnessResult,
  Health,
  Job,
  JobKind,
  MessageRow,
  MlCard,
  PlanRequest,
  PlanResult,
  RainEventResult,
  RunRow,
  SeasonEvent,
  SeasonRequest,
  SensitivityResult,
} from './types'

const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? ''

export class ApiUnavailable extends Error {}
/** The API is up but refused this request for now (rate limit or full solver queue). */
export class ApiBusy extends ApiUnavailable {}

async function request<T>(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? 30000)
  const onAbort = () => ctrl.abort()
  init.signal?.addEventListener('abort', onAbort)
  try {
    const res = await fetch(`${BASE}${path}`, { ...init, signal: ctrl.signal })
    if (res.status === 429) throw new ApiBusy(`API busy, retry after ${res.headers.get('retry-after') ?? '?'} s`)
    if (res.status >= 500 || res.status === 404 || res.status === 502 || res.status === 503) {
      throw new ApiUnavailable(`API ${res.status}`)
    }
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`API ${res.status}: ${body.slice(0, 200)}`)
    }
    const type = res.headers.get('content-type') ?? ''
    if (!type.includes('application/json')) throw new ApiUnavailable('API returned non-JSON (static host?)')
    return (await res.json()) as T
  } catch (err) {
    if (init.signal?.aborted) throw err
    if (err instanceof ApiUnavailable) throw err
    if (err instanceof TypeError || (err as Error).name === 'AbortError') throw new ApiUnavailable(String(err))
    throw err
  } finally {
    clearTimeout(timer)
    init.signal?.removeEventListener('abort', onAbort)
  }
}

let healthPromise: Promise<Health | null> | null = null
let healthAt = 0

export function health(force = false): Promise<Health | null> {
  if (!force && healthPromise && Date.now() - healthAt < 30000) return healthPromise
  healthAt = Date.now()
  healthPromise = request<Health>('/api/health', { timeoutMs: 4000 }).catch(() => null)
  return healthPromise
}

const post = <T>(path: string, body: unknown, signal?: AbortSignal, timeoutMs = 45000) =>
  request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
    timeoutMs,
  })

/** Run a request on the CP-SAT API; fall back to the browser engine only if the API is unreachable. */
async function withFallback<T>(apiCall: () => Promise<T>, browserCall: () => Promise<T>): Promise<{ data: T; engine: 'cp-sat' | 'heuristic' }> {
  const h = await health()
  if (h) {
    try {
      return { data: await apiCall(), engine: 'cp-sat' }
    } catch (err) {
      if (!(err instanceof ApiUnavailable)) throw err
      // A busy server is still up: fall back for this request only.
      if (!(err instanceof ApiBusy)) healthPromise = Promise.resolve(null)
    }
  }
  return { data: await browserCall(), engine: 'heuristic' }
}

const browser = () => import('@/engine/plan')

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}

/** Queue a solve on the server and poll until it finishes. Solves never hold a request open. */
async function viaJob<T>(kind: JobKind, params: object, signal?: AbortSignal, timeoutMs = 90000): Promise<T> {
  let job = await post<Job<T>>('/api/jobs', { kind, params }, signal, 15000)
  const deadline = Date.now() + timeoutMs
  let delay = 200
  while (job.status === 'queued' || job.status === 'running') {
    if (Date.now() > deadline) throw new ApiUnavailable(`job ${job.id} timed out`)
    await sleep(delay, signal)
    delay = Math.min(1000, delay * 1.5)
    job = await request<Job<T>>(`/api/jobs/${job.id}`, { signal, timeoutMs: 10000 })
  }
  // A failed solve falls back to the (labelled) browser engine, as an unreachable API does.
  if (job.status === 'failed' || !job.result) throw new ApiUnavailable(job.error ?? 'solver failed')
  return job.result
}

export function plan(req: PlanRequest, signal?: AbortSignal) {
  return withFallback<PlanResult>(
    () => viaJob<PlanResult>('plan', req, signal),
    async () => (await browser()).planInBrowser(req, signal),
  )
}

export function sensitivity(req: PlanRequest, signal?: AbortSignal) {
  return withFallback<SensitivityResult>(
    () => viaJob<SensitivityResult>('sensitivity', { ...req, persist: false }, signal),
    async () => (await browser()).sensitivityInBrowser(req),
  )
}

export function fairness(req: PlanRequest, signal?: AbortSignal) {
  return withFallback<FairnessResult>(
    () => viaJob<FairnessResult>('fairness', { ...req, persist: false }, signal),
    async () => (await browser()).fairnessInBrowser(req),
  )
}

export function rainEvent(req: PlanRequest & { forecastSlot?: number }, signal?: AbortSignal) {
  return withFallback<RainEventResult>(
    () => viaJob<RainEventResult>('rain-event', { ...req, persist: false }, signal),
    async () => (await browser()).rainEventInBrowser(req, req.forecastSlot ?? 20),
  )
}

let mlCardPromise: Promise<MlCard | null> | null = null

/** The trained models' card (held-out metrics); null when the API or the models are unavailable. */
export function mlCard(): Promise<MlCard | null> {
  mlCardPromise ??= request<MlCard>('/api/ml', { timeoutMs: 5000 }).catch(() => {
    mlCardPromise = null
    return null
  })
  return mlCardPromise
}

export async function messages(limit = 30): Promise<MessageRow[]> {
  try {
    return await request<MessageRow[]>(`/api/messages?limit=${limit}`, { timeoutMs: 5000 })
  } catch {
    return []
  }
}

export async function runs(limit = 12): Promise<RunRow[]> {
  try {
    return await request<RunRow[]>(`/api/runs?limit=${limit}`, { timeoutMs: 5000 })
  } catch {
    return []
  }
}

/** Stream a season simulation (server-sent events over a POST). */
export async function season(
  req: SeasonRequest,
  onEvent: (e: SeasonEvent) => void,
  signal?: AbortSignal,
): Promise<'cp-sat' | 'heuristic'> {
  const h = await health()
  if (!h) {
    const { simulateSeasonInBrowser } = await import('@/engine/season')
    await simulateSeasonInBrowser(req, onEvent, signal)
    return 'heuristic'
  }
  const res = await fetch(`${BASE}/api/season`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  })
  if (!res.ok || !res.body) throw new Error(`Season API ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const line = chunk.split('\n').find((l) => l.startsWith('data: '))
      if (line) onEvent(JSON.parse(line.slice(6)) as SeasonEvent)
    }
  }
  return 'cp-sat'
}
