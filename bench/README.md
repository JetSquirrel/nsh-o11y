# Benchmarks

Two sides, the same scenarios and the same data (`example/data.ts`'s seeded random walk, with spikes and a
dropout), one 1000 × 300 plot at 1× density:

- **nsh-o11y** in NSH's runtime (QuickJS), with the TypeScript store and with the Rust one: `nsh test perf`.
- **uPlot 1.6.31** in a headless Chrome or Edge (V8, browser Canvas 2D): `cd bench/uplot && bun install && bun run.ts`.

| Scenario | What a frame is |
|---|---|
| Full view | The whole series on screen: redraw everything. uPlot: `batch(() => redraw(true, true))`. nsh-o11y: `engine.update()` + `renderPlot` + `renderOverlay`. |
| Zooming | 30 frames, each 1.25× further in toward the middle, as a wheel zooms. uPlot: `batch(() => setScale("x", …))`. |
| Hover | The cursor moved. uPlot: `setCursor` (DOM). nsh-o11y: the overlay canvas only. |
| Live | 1M samples kept, a 5-minute window at 10 Hz (3000 samples) in view, one sample appended per frame. |
| Dashboard | 24 panels of 400 × 180, 3 series × 20,000 samples each, all redrawn. |

What is timed is the JavaScript side of a frame: building the paths and recording or issuing the canvas
calls. Neither side's rasterization is in it: NSH replays the recorded drawing natively after `draw` returns,
and Chrome rasterizes canvas work on its own schedule. Times are `performance.now()` around synchronous
calls (uPlot's `batch` commits before it returns).

The engines differ. V8 compiles uPlot's loops to machine code; QuickJS interprets nsh-o11y's TypeScript. The
comparison that matters for an NSH app is what each approach costs where the app runs, and the Rust store is
how nsh-o11y gets around the interpreter: the per-sample work happens in Rust, and JS sees about 4 points per
pixel column.

`results/` holds the latest runs (`uplot.md`) and the real-host screenshots from
`nsh test example/screenshot.test.tsx --target windows`.
