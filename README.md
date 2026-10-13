# SunShift: irrigation scheduling for the solar era

SunShift coordinates the irrigation pumps of every farm on a solarised agricultural feeder. Each morning
it reads the weather, works out how much water each crop needs (FAO-56), forecasts the feeder's solar
output (pvlib), and solves one shared pump schedule with Google OR-Tools CP-SAT. The goal is to keep
crops out of water stress, run pumps on solar, keep the feeder under its limit, and share scarce hours
fairly. Farmers get the result as an SMS or a voice call in Telugu, Hindi or English.

Built for **Yuva Yodha 2026, Schneider Electric Energy Tech Hackathon, Sustainable Agriculture track**.

| Route   | What it is |
| ------- | ---------- |
| `/`     | The story site: scroll-driven 3D world, with every number computed live by the engine |
| `/app`  | Live feeder dashboard: 3D twin, schedule board, constraint monitor, in-day re-planning (cloud bank, pump fault, rain) |
| `/demo` | Guided demo, about 100 s in 10 scenes. <kbd>Space</kbd> pauses, arrow keys skip. `/demo?autostart=1&scene=0` starts it immediately |

## Run it locally

Requirements: Python 3.11+, Node.js 20.19+ or 22.12+.

**API** (FastAPI on port 8000):

```bash
cd backend
python -m venv .venv
.venv/Scripts/activate            # macOS/Linux: source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app.main:app --reload --port 8000
```

**Site** (Vite on port 5173, which proxies `/api` to port 8000):

```bash
cd frontend
npm ci
npm run dev
```

Open http://localhost:5173. If the API is unreachable, the site switches to an in-browser engine (FAO-56,
solar model and a greedy scheduler ported to TypeScript) and labels every result "Browser heuristic", so
the demo never silently pretends to be the optimiser.

### As one service

FastAPI serves the built site as well as the API, so production is a single process:

```bash
npm --prefix frontend run build
uvicorn app.main:app --app-dir backend --host 0.0.0.0 --port 8000
```

### Docker, PostgreSQL and Render

```bash
docker compose up --build         # SunShift + PostgreSQL 17 on http://localhost:8000
```

The `Dockerfile` builds the site with Node 22 and runs it on Python 3.11. `render.yaml` is a Render
Blueprint (one Docker web service plus a managed PostgreSQL). The GitHub Actions workflow in
`.github/workflows/ci.yml` builds and smoke-tests the image on every push; it has not been built on a
developer machine yet, so check the first CI run before relying on it.

The database schema is managed by Alembic and migrated automatically at startup (several processes
starting together are safe on PostgreSQL). Databases created before migrations existed are upgraded in
place. To create a new migration after changing a model:

```bash
cd backend && alembic revision --autogenerate -m "describe the change"
```

### Configuration

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `DATABASE_URL` | SQLite file in `backend/data/` | PostgreSQL URL (`postgres://`, `postgresql://` and `postgresql+psycopg://` all work). Persistence is best-effort: if the database is down, planning still works and `/api/health` reports `db: unavailable` |
| `SUNSHIFT_API_KEY` | unset | Enables registry writes (farms, pumps, feeder capacity) for requests with a matching `X-API-Key` header. Unset means the registry is read-only |
| `ALLOWED_ORIGINS` | unset | Comma-separated origins allowed to call the API from another site. Unset means same-origin only, which is all the bundled site needs |
| `SOLVER_WORKERS` | `2` | Solves run at once, per process |
| `MAX_QUEUED_JOBS` | `16` | Solves allowed to wait; beyond that the API answers 429 with `Retry-After` |
| `MAX_TIME_LIMIT_S` | `5` | Server-side cap on the solver time a request can ask for |
| `MAX_CONCURRENT_SEASONS` | `1` | Season simulations at once, per process |
| `PLAN_CACHE_S`, `STUDY_CACHE_S` | `120`, `600` | How long an identical plan or study reuses a finished result |
| `RATE_LIMITS` | `on` | Per-client rate limits; `off` disables them |
| `RATE_LIMIT_COMPUTE`, `_SEASON`, `_ADMIN`, `_READ` | `30/12`, `6/2`, `60/20`, `1200/200` | Requests per minute / burst, per client IP |
| `RUNS_RETENTION`, `JOBS_RETENTION_H` | `5000`, `24` | Stored plan runs kept, and hours finished jobs are kept |
| `LOG_LEVEL` | `INFO` | Python log level |
| `SUNSHIFT_STATIC` | `frontend/dist` | Built site to serve |
| `SUNSHIFT_SCENARIO` | `shared/scenario.json` | Feeder scenario file |
| `PORT` | `8000` | Listening port inside the Docker image |

## Tests

```bash
cd backend && python -m pytest       # 88 tests
cd frontend && npm test              # 23 tests
```

The API tests run every case twice: on SQLite and on a real PostgreSQL. Locally that PostgreSQL comes
from the `pgserver` package in `requirements-dev.txt`; CI uses a PostgreSQL service through
`TEST_DATABASE_URL`.

- The agronomy tests reproduce **FAO-56 Example 18** (Uccle, 6 July: ET₀ = 3.9 mm/day), Examples 2 and 3,
  and check that the root-zone water balance conserves water.
- The optimiser tests generate random 16-farm problems, normal and scarce, and check every hard constraint
  on whatever CP-SAT returns. They also check that the solver never does worse than its warm start, that
  the fairness floor beats pure throughput under scarcity, and that re-optimisation keeps slots that have
  already run. The greedy fallback is checked the same way in Python and TypeScript.
- The planner tests run the whole pipeline offline: a physically plausible PV profile, feeder limits
  respected, the uncoordinated baseline overloading where SunShift does not, and rain deferring irrigation.
- The API tests cover the job queue and result reuse, the full-queue and rate-limit 429s, the time-limit
  cap, API-key checks, the farm registry (changes reach the planner; invalid farms are rejected), CORS,
  errors that never expose internals, migrations matching the models, upgrading a pre-migration database,
  and planning with the database down.
- A parity fixture (`shared/fixtures/engine-parity.json`) holds the Python engine's answers to fixed
  inputs. A Python test fails if the engine changes without regenerating it (`python -m tests.parity`),
  and a TypeScript test fails if the browser engine disagrees with it.
- The ML tests re-check the shipped models on a stored sample of the held-out year (offline): the likely
  solar curve must beat the raw forecast by at least 10% RMSE, the cautious curve must miss between 5% and
  16% of hours, and the rain model must beat the forecast's yes/no and the base rate. They also check
  that corrections apply only to real forecasts, that plans fall back cleanly without models, and that
  the optimiser moves pumping out of hours the cautious curve flags.

## How it works

```
weather ─► ET₀ ─► crop water need ─► soil-water balance ─► today's requirement per farm ─┐
   │                                                                                     ├─► CP-SAT ─► schedule + reasons ─► SMS / IVR / pump controller
   └─────────► PV forecast (pvlib) ─► solar power per 15-minute slot ────────────────────┘
```

- **Weather**: Open-Meteo forecast (15-minute radiation, hourly met variables). If that fails, the last
  cached forecast; if there is none, monthly climatology. Season replays use the Open-Meteo ERA5 archive.
  Every result carries its source, and the UI shows it.
- **Crop water**: FAO-56 Penman–Monteith ET₀ (Eq. 6), single crop coefficient Kc by growth stage, root-zone
  depletion (Eq. 85) with TAW, RAW and the stress coefficient Ks, and effective rain with runoff. Cotton,
  maize, groundnut and chilli on five soil types, irrigated by drip, sprinkler or furrow. When the 30-hour
  forecast gives at least a 50% chance of 2 mm or more of rain, the effective rain is counted against each
  farm's need, and farms whose need it covers, or nearly covers, are deferred.
- **Solar**: pvlib solar position, Erbs decomposition, Hay–Davies transposition, Faiman cell temperature,
  and PVWatts DC and inverter models for the feeder's 120 kWp / 95 kW plant.
- **Optimiser**: a time-indexed CP-SAT model with 20 pumps × 48 fifteen-minute slots (06:00–18:00).
  - Hard constraints: availability windows, a minimum run of 30 minutes, at most two starts per day, no
    over-irrigation, the 60 kW feeder limit, and solar output plus at most 15 kW of grid backup.
  - Lexicographic objective: first maximise the fairness floor (the smallest share of its need any farm
    receives, averaged with yesterday's share so shortfalls are repaid), then maximise priority-weighted
    service minus grid import, peak load and pump starts. When the ML cautious solar curve is available,
    pumping above it is penalised at half the weight of grid import.
  - A greedy schedule seeds the search, so the solver can only improve on it. During the day, slots that
    have already run are fixed and the rest of the day is re-optimised.
- **Baselines**: two comparisons, both through the same pump and feeder physics.
  - *Uncoordinated*: the same water need, but every farmer starts at their habitual time. Load above the
    feeder limit cannot be delivered and is counted as overload.
  - *Business-as-usual* (multi-day only): farmers apply 1.3 × the month's climatological need on fixed
    rotations (drip daily, sprinkler every 2 days, furrow every 3).
- **Season simulation**: replays real ERA5 weather day by day. SunShift plans on a forecast with modelled
  error (85% rain detection, 8% false alarms, σ ≈ 10% solar error); each day is then executed against the
  actual weather. Results stream to the browser over Server-Sent Events.

## Machine learning

Two models correct the weather inputs. Both are trained on Open-Meteo's archived **day-ahead** forecasts
(what the forecast said the day before) against **ERA5 reanalysis** (what happened), for the four scenario
locations. Training covers 2024-01-20 to 2025-09-30; the final 12 months (Oct 2025 to Sep 2026) are held
out, and every number below comes from them. Training, evaluation and the backtest are one command:

```bash
cd backend && python -m app.ml.train
```

It writes `app/ml/artifacts/` (the models, a held-out sample for the tests, and `model_card.json`, which
`GET /api/ml` serves). The `/app` dashboard shows what the models changed in today's plan.

**Solar forecast correction.** Gradient-boosted quantile regression of the clear-sky index gives a
*likely* (P50) curve, which the plan uses instead of the raw forecast, and a *cautious* (P10) curve, which
the optimiser uses to keep pumping away from hours where a dim day would leave the pumps on grid power.
The cautious curve's offset is calibrated out-of-fold on contiguous three-month blocks.

| Held-out year (16,406 daylight hours) | Raw forecast | ML likely curve |
| --- | --- | --- |
| Hourly error, RMSE | 100.0 W/m² | **85.6 W/m²** (−14%) |
| Hourly error, MAE | 58.2 W/m² | **55.1 W/m²** |
| Bias | +25.4 W/m² | **+5.8 W/m²** |
| Daily solar energy error | 0.496 kWh/m² | **0.435 kWh/m²** (−12%) |

The likely curve improves at all four locations. Actual solar fell below the cautious curve in 12.0% of
hours (target 10%), and more than 25 W/m² below it in 7.1%.

**Calibrated rain probability.** Logistic regression on the forecast's 30-hour rain amount, timing and
cloud turns it into the probability of meaningful rain (at least 2 mm), which drives irrigation deferral.

| Held-out year (1,456 location-days) | Brier score | Wrong deferrals | Missed rain |
| --- | --- | --- | --- |
| Forecast as yes/no | 0.109 | 121 | 38 |
| Historical frequency | 0.121 | 230 | 77 |
| **Calibrated model** | **0.069** | **108** | 40 |

**Does it help the plan?** For 164 held-out location-days, the training script planned each day twice,
once with the raw forecast and once with the ML curves, and replayed both schedules against the solar
that actually arrived:

| Per day | Raw-forecast plan | ML plan |
| --- | --- | --- |
| Grid energy | 55.4 kWh | **51.6 kWh** (−6.8%) |
| Pumping cut by overload | 6.4 kWh | **6.0 kWh** (−6.9%) |
| Water delivered | 1,452 m³ | 1,436 m³ (−1.1%) |
| Grid energy per 100 m³ | 3.81 kWh | **3.59 kWh** (−5.8%) |

Most of the gain comes from the corrected likely curve; an ablation on 84 of those days showed the
cautious-curve penalty adding about 2 percentage points more. The ML plan delivers slightly less water
because it plans for the sun that is actually likely, not the forecast's over-sunny version.

What these models do not do, stated plainly:

- They are checked against ERA5 reanalysis, a model reconstruction, not ground stations.
- Forecast errors change from year to year. The held-out year's 2026 monsoon was far worse for the solar
  forecast than 2024's, and its dry season slightly the other way, so the cautious curve missed 12% of
  hours rather than 10%.
- Rain fell on 15% of held-out days against 26% in training. In that drier year the rain model's
  mid-range probabilities were too high (days it gave about 50% saw rain 23% of the time), although it
  still beat the forecast's yes/no on every score.
- An upper (P90) solar band was tested and is not shipped: it was badly under-calibrated.
- The corrections apply to real forecasts only: not to climatology, ERA5 replays or demo weather
  scenarios, and not in the browser fallback engine. The season simulation still uses its modelled
  forecast errors, not these models.

## Data honesty

| Real, computed live | Simulated | Designed, not built |
| ------------------- | --------- | ------------------- |
| Weather from Open-Meteo or ERA5, wherever it is labelled so | The 20 farms: crops, soils, pumps, availability windows and yesterday's service | The pump controller hardware and firmware (the site shows the electrical design) |
| ET₀, crop need and the soil-water balance (FAO-56) | Pump telemetry and faults on `/app` | The SMS and IVR gateway (messages and call scripts are generated, then previewed in the browser; the IVR voice uses the browser's speech synthesis) |
| The PV output model (pvlib) | Yield effects: a relative index from FAO-33 Ky factors, not measurements | DISCOM / feeder SCADA integration |
| Every CP-SAT solve and every baseline comparison | | |
| The ML corrections and their held-out results (trained on archived forecasts against ERA5) | | |

All savings shown are comparisons between strategies on this simulated feeder. None are field results.

## API

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET  | `/api/health` | Engine, library versions, database and registry status, solver queue, default plan date |
| GET  | `/api/scenario` | The feeder scenario (farms, crops, soils, locations), from the registry |
| GET  | `/api/ml` | The ML model card: data, training and test periods, held-out metrics, backtest, limitations |
| POST | `/api/jobs` | Queue a solve: `{"kind": ..., "params": {...}}` with kind `plan`, `sensitivity`, `fairness` or `rain-event`. Returns 202 and a job to poll, or 200 with the result when an identical request was just solved |
| GET  | `/api/jobs/{id}` | A job's status (`queued`, `running`, `done`, `failed`) and, when done, its result |
| POST | `/api/plan` | Plan one day. Accepts weather modes, solar events, fixed/executed slots for re-planning, crop overrides and failure drills. Runs as a job and waits for it, for simple clients |
| POST | `/api/sensitivity` | Which constraint is binding: relaxes solar, the feeder limit and grid backup one at a time and measures the extra irrigation each allows |
| POST | `/api/fairness` | Fair allocation vs maximum throughput under scarcity |
| POST | `/api/rain-event` | Mid-day rain forecast: what gets cancelled, and the water and energy saved |
| GET  | `/api/weather` | The weather inputs the planner uses for a date |
| POST | `/api/season` | Multi-day simulation, streamed as Server-Sent Events |
| GET  | `/api/runs`, `/api/runs/{id}` | Stored plan and season runs |
| GET  | `/api/feeders`, `/api/feeders/{id}` | Feeders in the registry, and a feeder's farms and pumps |
| GET  | `/api/farms/{id}` | One farm and its pump |
| PATCH | `/api/feeders/{id}` | Change a feeder's name, location or capacities. Needs `X-API-Key` |
| POST | `/api/feeders/{id}/farms` | Add a farm (crop, soil, method, area, sowing date or days after sowing, availability, pump). Needs `X-API-Key` |
| PATCH | `/api/farms/{id}` | Change a farm or its pump, including measured pump power or flow. Needs `X-API-Key` |
| DELETE | `/api/farms/{id}` | Deactivate a farm (kept for history). Needs `X-API-Key` |

Every solve runs on a bounded worker pool, never inside the web request. Identical requests share one
solve, and a recent finished result is reused. When the queue is full, or a client sends too many
requests, the API answers `429` with `Retry-After`; the site then falls back to its in-browser engine for
that request and labels the result. Errors return a generic message and a reference; the details are
only in the server log.

The registry is seeded from `shared/scenario.json` on first start (re-seed by hand with
`python -m app.registry seed --reset`). After that, plans use the farms in the database. Farms with a
sowing date advance through their crop stages day by day. Plans report whether their farms are all
simulated demo data (`meta.sources.farms`).

Interactive docs: http://localhost:8000/docs.

## Project layout

```
shared/scenario.json      the feeder, farms, crops, soils and policy, read by both engines
backend/app/engine/       weather, agronomy (FAO-56), solar (pvlib), optimiser (CP-SAT), heuristic,
                          baselines, metrics, explanations, planner, season simulation
backend/app/api.py        FastAPI routes and request models
backend/app/jobs.py       the bounded solver queue: shared solves, result reuse, polling
backend/app/registry.py   feeders, farms and pumps in the database; builds the scenario the planner uses
backend/app/ratelimit.py  per-client rate limits (security.py: the API key for registry writes)
backend/app/db.py         SQLAlchemy models and persistence (PostgreSQL or SQLite)
backend/migrations/       Alembic migrations, applied at startup
backend/app/ml/           ML weather corrections: features, data fetch, training (train.py), runtime, artifacts/
backend/tests/            pytest suite (engine, API on SQLite and PostgreSQL, engine parity)
frontend/src/sections/    the story site, one file per section
frontend/src/routes/      Home, LiveApp (/app), Demo (/demo)
frontend/src/three/       React Three Fiber scenes and the procedural feeder world
frontend/src/engine/      the in-browser fallback engine (TypeScript port) and its tests
```

## Limitations

- The registry stores farms and pumps, but nothing ingests live telemetry yet (SCADA, smart meters or pump
  controllers), and no SMS or IVR gateway is connected. Pump events on `/app` are simulated.
- Soil moisture is modelled, not sensed. A few probes per feeder would let the balance recalibrate itself.
- One API key guards all registry writes; there are no user accounts or roles. Planning is open to anyone
  who can reach the server, protected by rate limits and the bounded queue.
- The solver queue and rate limits are per process. With several processes, polls work across all of them
  (jobs live in the database), but capacity and limits add up per process; a shared queue (e.g. Redis)
  would be the next step for a multi-server deployment.
- The 3D world draws the 20 plots of the demo layout; farms added through the API appear in plans,
  schedules and lists but not as plots on the map.

## Credits

[Weather data by Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0). Historical replays contain modified
Copernicus Climate Change Service information (ERA5). Allen et al., *FAO Irrigation and Drainage Paper 56*
(1998). [pvlib python](https://pvlib-python.readthedocs.io/). [Google OR-Tools](https://developers.google.com/optimization).
