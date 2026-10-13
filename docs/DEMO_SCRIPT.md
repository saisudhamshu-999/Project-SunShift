# SunShift demo video script (about 2 minutes 45 seconds)

Record at 1920×1080 in a normal browser (not a preview pane), with the API running so plans come from
CP-SAT. Open `/demo?autostart=1` for part 2; it plays ten scenes in about 101 seconds and the narration
below is timed to them. Numbers on screen come from the day you record: read them from the screen,
not from this script.

Before recording:
- Check the header chip says **CP-SAT online** (not "Browser fallback").
- Turn sound on if you want the ambient track; turn it off for voice-over only.
- Use a quiet room and a headset microphone; speak a little slower than feels natural.

## Part 1 · The problem (0:00 to 0:20) · home page, hero

Scroll slowly through the first screen as the camera rises from the soil to the feeder.

> On a solarised farm feeder, power is free in daylight, so every farmer switches on at sunrise.
> The line overloads, solar later in the day goes unused, and the farms at the end of the line get the least water.
> SunShift plans every pump on the feeder together.

## Part 2 · Guided demo (0:20 to 2:00) · `/demo?autostart=1`

| Time | Scene | Say |
| --- | --- | --- |
| 0:20 | 1 · The sun rises (8 s) | "This is Feeder 07: one solar plant, one line, twenty farms. Here is today's real forecast." |
| 0:28 | 2 · Farmers need water (9 s) | "For every farm we run the FAO-56 water balance, the standard irrigation engineers use, to work out how much water each crop needs today." |
| 0:37 | 3 · Without coordination (10 s) | "If everyone starts at their usual time, the line goes over its limit; read the minutes on screen. Protection trips, and water never arrives." |
| 0:47 | 4 · SunShift optimises (10 s) | "SunShift hands the whole feeder to Google's CP-SAT solver: every pump, every fifteen minutes, with fairness first." |
| 0:57 | 5 · Pumps take turns (12 s) | "Now the pumps take turns on the sun. Peak load stays under the limit, and more of the water arrives." |
| 1:09 | 6 · Rain forecast (9 s) | "At eleven, the forecast changes: rain at one o'clock. SunShift recomputes every farm's water balance with the rain it expects." (This scene injects the rain as a scenario; on real forecasts our ML model calibrates the rain probability.) |
| 1:18 | 7 · Don't pump the rain (9 s) | "So SunShift cancels irrigation the rain will do for free. Read the litres and kilowatt-hours saved." |
| 1:27 | 8 · The sun changes (9 s) | "Another day: a cloud bank cuts solar output in the afternoon." |
| 1:36 | 9 · Re-optimise (10 s) | "What already ran stays. The rest of the day is re-solved in seconds, and only the windows that must move, move." |
| 1:46 | 10 · Impact (15 s) | "Same farms, same water needs. Only the timing changed. One sun, many farms, one coordinated system." |

## Part 3 · The live product (2:01 to 2:35) · `/app`

1. Point at the KPI strip and the solar strip: "This is the operator's live view. The bars are today's solar, corrected by our ML model; the blue ticks are the cautious curve the optimiser plans around."
2. Click a farm in the schedule: "Every farmer gets a reason, and an SMS in Telugu, Hindi or English."
3. Click **Rain forecast arrives now**: "When the weather changes, one click re-plans the day; the log shows what moved."
4. Point at **Farmer messages**: "Farmers reply 1 to confirm, or send a better time; SunShift re-plans and messages everyone whose window moved."

## Part 4 · Close (2:35 to 2:45) · back to the home page footer or the pitch deck's last slide

> SunShift is real software on real weather, tested on a year of data it never saw.
> The farms are simulated today; what we want next is one real feeder for one season.

## Honesty checklist (say or show at least once)

- The twenty farms are a simulation; weather, agronomy, solar model, optimiser, ML and messaging are real.
- Savings are comparisons on the simulated feeder, not field results.
- The pump controller is a design, not built yet.
