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
Blueprint (one Docker web service plus a managed PostgreSQL). Neither the image nor the blueprint has
been built yet (Docker was not available while this was written), so run `docker compose up --build`
once before relying on them.

### Configuration

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `DATABASE_URL` | SQLite file in `backend/data/` | PostgreSQL URL (`postgres://`, `postgresql://` and `postgresql+psycopg://` all work). Persistence is best-effort: if the database is down, planning still works and `/api/health` reports `db: unavailable` |
| `ALLOWED_ORIGINS` | `*` | Comma-separated CORS origins |
| `LOG_LEVEL` | `INFO` | Python log level |
| `SUNSHIFT_STATIC` | `frontend/dist` | Built site to serve |
| `SUNSHIFT_SCENARIO` | `shared/scenario.json` | Feeder scenario file |
| `PORT` | `8000` | Listening port inside the Docker image |

## Tests

```bash
cd backend && python -m pytest       # 31 tests
cd frontend && npm test              # 20 tests
```

- The agronomy tests reproduce **FAO-56 Example 18** (Uccle, 6 July: ET₀ = 3.9 mm/day), Examples 2 and 3,
  and check that the root-zone water balance conserves water.
- The optimiser tests generate random 16-farm problems, normal and scarce, and check every hard constraint
  on whatever CP-SAT returns. They also check that the solver never does worse than its warm start, that
  the fairness floor beats pure throughput under scarcity, and that re-optimisation keeps slots that have
  already run. The greedy fallback is checked the same way in Python and TypeScript.
- The planner tests run the whole pipeline offline: a physically plausible PV profile, feeder limits
  respected, the uncoordinated baseline overloading where SunShift does not, and rain deferring irrigation.

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
    service minus grid import, peak load and pump starts.
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

## Data honesty

| Real, computed live | Simulated | Designed, not built |
| ------------------- | --------- | ------------------- |
| Weather from Open-Meteo or ERA5, wherever it is labelled so | The 20 farms: crops, soils, pumps, availability windows and yesterday's service | The pump controller hardware and firmware (the site shows the electrical design) |
| ET₀, crop need and the soil-water balance (FAO-56) | Pump telemetry and faults on `/app` | The SMS and IVR gateway (messages and call scripts are generated, then previewed in the browser; the IVR voice uses the browser's speech synthesis) |
| The PV output model (pvlib) | Yield effects: a relative index from FAO-33 Ky factors, not measurements | DISCOM / feeder SCADA integration |
| Every CP-SAT solve and every baseline comparison | | |

All savings shown are comparisons between strategies on this simulated feeder. None are field results.

## API

| Method | Path | Purpose |
| ------ | ---- | ------- |
| GET  | `/api/health` | Engine, library versions, database status, default plan date |
| GET  | `/api/scenario` | The feeder scenario (farms, crops, soils, locations) |
| POST | `/api/plan` | Plan one day. Accepts weather modes, solar events, fixed/executed slots for re-planning, crop overrides and failure drills |
| POST | `/api/sensitivity` | Which constraint is binding: relaxes solar, the feeder limit and grid backup one at a time and measures the extra irrigation each allows |
| POST | `/api/fairness` | Fair allocation vs maximum throughput under scarcity (cached for 10 minutes) |
| POST | `/api/rain-event` | Mid-day rain forecast: what gets cancelled, and the water and energy saved (cached for 10 minutes) |
| GET  | `/api/weather` | The weather inputs the planner uses for a date |
| POST | `/api/season` | Multi-day simulation, streamed as Server-Sent Events |
| GET  | `/api/runs`, `/api/runs/{id}` | Stored plan and season runs |

Interactive docs: http://localhost:8000/docs.

## Project layout

```
shared/scenario.json      the feeder, farms, crops, soils and policy, read by both engines
backend/app/engine/       weather, agronomy (FAO-56), solar (pvlib), optimiser (CP-SAT), heuristic,
                          baselines, metrics, explanations, planner, season simulation
backend/app/api.py        FastAPI routes and request models
backend/app/db.py         SQLAlchemy persistence (PostgreSQL or SQLite)
backend/tests/            pytest suite
frontend/src/sections/    the story site, one file per section
frontend/src/routes/      Home, LiveApp (/app), Demo (/demo)
frontend/src/three/       React Three Fiber scenes and the procedural feeder world
frontend/src/engine/      the in-browser fallback engine (TypeScript port) and its tests
```

## Limitations

- One feeder scenario. A real deployment needs a farm registry and feeder telemetry (SCADA or smart meters).
- Soil moisture is modelled, not sensed. A few probes per feeder would let the balance recalibrate itself.
- The API has no authentication or rate limiting. It is a demonstration server.

## Credits

[Weather data by Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0). Historical replays contain modified
Copernicus Climate Change Service information (ERA5). Allen et al., *FAO Irrigation and Drainage Paper 56*
(1998). [pvlib python](https://pvlib-python.readthedocs.io/). [Google OR-Tools](https://developers.google.com/optimization).
