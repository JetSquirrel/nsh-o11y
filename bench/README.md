# Benchmarks

The same scenarios and the same data (`example/data.ts`'s seeded random walk, with spikes and a dropout) on
one 1000 × 300 plot at 1× density, in two places:

- **In NSH** (QuickJS): nsh-o11y with its TypeScript store and with its Rust one. `nsh test perf`.
- **In a browser** (V8, Canvas 2D): nsh-o11y's TypeScript engine next to uPlot, ECharts, Chart.js, Plotly and
  Dygraphs. `cd bench/web && bun install && bun run.ts`. Each library runs each scenario in a fresh headless
  Chrome or Edge, so one library's garbage or crash can't touch the next.

| Scenario | What a frame is |
|---|---|
| Full view | The whole series on screen, the x range set again (alternately 1 ms wider), so every frame recomputes as a pan or resize would. |
| Zooming | 30 frames, each 1.25× further in toward the middle, as a wheel zooms. |
| Hover | The cursor moved, and whatever that draws (crosshair, tooltip, legend). |
| Live | 1M samples kept, a 5-minute window at 10 Hz (3000 samples) in view, one sample appended per frame. |
| Dashboard | 24 panels of 400 × 180, 3 series × 20,000 samples each, all redrawn. |

Each library is set up as its docs recommend for big series (`bench/web/src/adapters.ts`):

| Library | Setup |
|---|---|
| nsh-o11y | min/max pyramid + M4 per pixel column; plot and overlay on two canvases |
| uPlot | x in seconds, `null` gaps, `batch` around each change (it draws every point in view) |
| ECharts | canvas renderer, `sampling: 'lttb'`, a flat `Float64Array`, an inside `dataZoom` that filters |
| Chart.js | the decimation plugin (`min-max`), `parsing: false`, `normalized`, `update('none')` |
| Plotly | `scattergl` (WebGL), typed arrays, `relayout`; hover isn't timed (asynchronous); no dashboard (browsers keep about 16 WebGL contexts) |
| Dygraphs | row arrays, `dateWindow`, `setSelection` (no decimation) |

`bun run.ts --shots` draws each at 100k samples into `results/shots/`, to check each is set up right.

What is timed is the JavaScript side of a frame: computing what to draw and issuing (or, in NSH, recording)
the canvas calls, with `performance.now()` around calls that have drawn when they return: uPlot's `batch`,
ECharts after `zr.flush()`, Chart.js and Dygraphs with animations off, Plotly's promises, nsh-o11y's
`draw`. Rasterization isn't in it on either side: NSH replays the recorded drawing natively after `draw`
returns, and the browser rasterizes on its own schedule (Plotly's WebGL on the GPU, or SwiftShader).

A scenario stops timing once its frames have taken 20 s (after at least 3), and a run that doesn't answer in
6 minutes is counted as not finished (out of memory or hung).

`results/` holds the latest runs: `web.md` / `web.json`, `perf-run.log`, and the real-host screenshots from
`nsh test example/screenshot.test.tsx --target windows`. It is not committed.
