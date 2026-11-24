# nsh-o11y

Observability charts for [Native Shell (NSH)](https://nsh.dev), written in TSX, with an optional Rust backend
for large data. It starts with one component, `TimeSeriesChart`, built to beat [uPlot](https://github.com/leeoniya/uPlot)
where native O11y dashboards need it: millions of points, zooming, live data, many panels. It draws on NSH's
native `<Canvas>`, so it runs on every NSH platform, and ships as an nshm, laid out like
[nsh-graph](../nsh-graph).

- **Level of detail**: each series keeps a min/max pyramid (blocks of 8, 64, 512… samples). A frame is M4
  decimation (first, min, max and last of each pixel column) with the min and max read from the pyramid. Its
  cost follows the plot's width, not the number of points: a full view of 10 million samples costs about what
  10 thousand do. Spikes and dropouts one sample wide are never lost.
- **Two layers**: the grid, axes and series go on one canvas and the crosshair, dots and zoom box on
  another, so moving the pointer never redraws the data.
- **Rust backend**: register it and samples live in Rust. They cross into Rust once, when appended, and
  each frame one SVG path per series comes back. This also gets past NSH's 256 MB JS heap: the TypeScript
  store fits about 2 million samples, the Rust one hundreds of millions.
- **Live data**: `append` one sample or a batch; `maxPoints` keeps a window, dropping old samples in
  batches that shift the pyramid instead of rebuilding it; `window` shows the last N ms and follows.
- **Interaction**: drag to zoom to a range (Shift-drag or `dragMode="pan"` pans), wheel / pinch zooms,
  sideways swipe or Shift+wheel pans, double-click resets; fingers pan and pinch; arrow keys step the cursor,
  `+`/`-` zoom, Backspace goes back a zoom, `0` resets.
- **For O11y**: units (`short`, `bytes`, `ms`, `percent`, `reqps`…), time axes on calendar-friendly
  steps in local time or UTC, thresholds (SLOs), annotations (deploys, incidents), gaps for missing data,
  steps, fills, a legend with values at the cursor that toggles series, and a shared crosshair and zoom
  across panels (`createChartSync`).
- **Accessible**: the chart reads as its title, the time and every value under the cursor; keyboard
  navigation; the series palette is the color-blind-checked one from nsh-graph.

## Use

```tsx
import { mount, View } from "nsh";
import { TimeSeriesChart, createChartSync, createTimeSeries } from "nsh-o11y";

const latency = createTimeSeries({ series: 3, maxPoints: 100_000 });
setInterval(() => latency.append(Date.now(), [p50(), p95(), p99()]), 1000);

function App() {
  const sync = createChartSync();
  return (
    <View style={{ flex: 1, gap: 12, padding: 16 }}>
      <TimeSeriesChart
        title="Latency"
        data={latency}
        series={[{ label: "p50" }, { label: "p95" }, { label: "p99", width: 1 }]}
        unit="ms"
        softMin={0}
        window={15 * 60_000}
        thresholds={[{ value: 250, label: "SLO", color: "#e34948" }]}
        annotations={[{ time: deployedAt, label: "deploy v2.14" }]}
        sync={sync}
        style={{ flex: 1 }}
      />
    </View>
  );
}

mount(App);
```

`data` also takes plain arrays: `data={{ x: times, ys: [cpu, mem] }}`. Times are milliseconds and must not
decrease. `NaN` is a missing value.

### Props

| Prop | Default | |
|---|---|---|
| `data` | (required) | A store from `createTimeSeries`, or `{ x, ys }`. |
| `series` | (required) | One `SeriesOptions` per y column: `label`, `color`, `width` (1.5), `fill` (opacity, or `true`), `dash`, `step`, `spanGaps`, `show`, `unit`. |
| `title` | | |
| `unit` | `"short"` | `"none"`, `"short"`, `"percent"`, `"percentunit"`, `"bytes"`, `"decbytes"`, `"bits"`, `"ms"`, `"s"`, `"ns"`, `"reqps"`, `"ops"`, or a function. |
| `yMin` / `yMax` | auto | Fixed ends of the y range. |
| `softMin` / `softMax` | | Kept inside the auto range: `softMin={0}` for rates. |
| `window` | all data | Live: the last `window` ms, following new samples. |
| `thresholds` | | `{ value, color?, label?, dash? }[]` |
| `annotations` | | `{ time, end?, label?, color? }[]`: moments, or spans with `end`. |
| `timeZone` | `"local"` | or `"utc"`. |
| `legend` | `true` | Values at the cursor (or the newest); a press toggles the series. |
| `dragMode` | `"zoom"` | What a mouse drag does: `"zoom"` (a box) or `"pan"`. |
| `sync` | | `createChartSync()`: a shared crosshair and zoom. |
| `controller` | | `createChartController()`. |
| `colors` | theme | `background`, `text`, `muted`, `grid`, `cursor`, `selection`, `palette`. |
| `fontFamily` / `fontSize` | `"system-ui"` / 11 | |
| `onCursor(info)` | | The sample under the cursor and each series' value, or null. |
| `onRangeChange(range)` | | `[x0, x1]` after a zoom or pan, `null` when following again. |

### Stores

```ts
const ts = createTimeSeries({ series: 2, maxPoints: 1_000_000 }); // Rust when registered, else TypeScript
ts.append(t, [a, b]);                         // one sample
ts.append(times, [as, bs]);                   // a batch (arrays or typed arrays)
ts.setData(times, [as, bs]);  ts.clear();
ts.length();  ts.x(i);  ts.y(s, i);  ts.nearest(t);  ts.extent(s, i0, i1);
ts.trace(s, { x0, x1, y0, y1, left, top, width, height });  // SVG path data for a viewport
```

`TimeSeries`, `ChartEngine`, `renderPlot`, `renderOverlay` and the scale helpers are plain TypeScript with no
NSH imports. Use them headless or with any Canvas 2D context.

### Controller

```ts
const chart = createChartController();
chart.range();  chart.following();  chart.cursor();      // reactive
chart.setRange(t0, t1);  chart.zoom(2);  chart.back();  chart.reset();  chart.toggleSeries(1);
const png = await chart.toImage({ scale: 2 });          // Blob
```

## Rust backend

```ts
import * as native from "nsh-o11y/native";
import { setNativeBackend, type NativeBackend } from "nsh-o11y";
setNativeBackend(native as unknown as NativeBackend);
```

Stores made after that keep their samples in Rust (`native/src/lod.rs`), with the same pyramid and tracer step
for step. `perf.test.ts` checks that both draw identical paths. Without it the TypeScript store runs, and
apps without Rust keep working. As with nsh-graph, a local checkout added with `--path` builds with the app's
dev profile. Copy `.cargo/config.toml` into the app to build the crate optimized.

## How it works

```
nsh.json              the nshm: exports "nsh-o11y" (src/index.ts)
Cargo.toml            the crate: the Rust module "nsh-o11y/native" (native/src/lib.rs)
src/
  store.ts            columnar samples, the min/max pyramid, M4 tracing to SVG path data
  native.ts           the Rust store behind the same interface; createTimeSeries
  chart.ts            the engine: viewport, auto-scale, zoom history, cursor, zoom box
  scale.ts            time and value ticks, units
  render.ts           the plot layer and the overlay layer, Canvas 2D
  TimeSeriesChart.tsx the component: two canvases, input, legend
  sync.ts             shared cursor and zoom across charts
  controller.ts       imperative handle, image export
  palette.ts          series colors
native/src/
  lib.rs              the native module: SeriesBuffer
  lod.rs              the pyramid and the tracer in Rust
example/              a service dashboard (live panels + a big one), tests
perf/                 the same dashboard with the Rust backend; TypeScript vs Rust benchmark
bench/uplot/          uPlot on the same scenarios, in a headless browser
```

On QuickJS, which runs TSX on every NSH platform except the web, per-call costs dominate. So a series is one
`Path2D` built from SVG path data, not thousands of `lineTo` calls, and its coordinates are integers in tenths of
a point, drawn under `scale(0.1)`, which is faster to write and parse than decimals. Each column's samples are
found by galloping from where an even spread would put them, not by a full binary search.

## Performance

See [bench/README.md](bench/README.md) for the method. Each figure is the JavaScript time of one frame on a
1000 × 300 plot, with one series, measured on a 4-core Windows Server VM.

**uPlot 1.6.31** in headless Edge (V8):

| Samples | Create + first draw | Full-view frame, mean / p95 | Zooming frame, mean / p95 |
|---|---|---|---|
| 100,000 | 55 ms | 11.8 / 20.4 ms | 2.3 / 8.5 ms |
| 1,000,000 | 119 ms | 97 / 106 ms | 13.5 / 63 ms |
| 10,000,000 | 1002 ms | 960 / 1000 ms | 128 / 608 ms |

Live (1M kept, 3000 in view): 0.43 ms a frame. Dashboard (24 panels × 3 × 20k): 188 ms for all panels.

**nsh-o11y** in NSH 0.6's runtime (QuickJS), `nsh test perf`:

| Samples | Store | Load | Full-view frame, mean / p95 | Zooming frame, mean / p95 | Hover |
|---|---|---|---|---|---|
| 100,000 | TypeScript | 26 ms | 14.2 / 30.6 ms | 6.5 / 14.6 ms | 0.07 ms |
| 100,000 | Rust | 6.6 ms | 1.8 / 3.1 ms | 0.84 / 1.7 ms | 0.30 ms |
| 1,000,000 | TypeScript | 1324 ms | 20.2 / 51 ms | 9.6 / 12.4 ms | 0.07 ms |
| 1,000,000 | Rust | 79 ms | 2.6 / 3.1 ms | 1.0 / 2.3 ms | 0.04 ms |
| 10,000,000 | TypeScript | out of memory (256 MB JS heap) | | | |
| 10,000,000 | Rust | 1277 ms | 4.4 / 7.4 ms | 3.2 / 4.6 ms | 0.48 ms |

| | TypeScript | Rust | uPlot |
|---|---|---|---|
| Live (1M kept, 3000 in view), a frame | 2.1 / 6.9 ms | 0.94 / 3.0 ms | 0.43 / 0.60 ms |
| Dashboard (24 panels × 3 × 20k), all panels | 491 / 560 ms | 46 / 78 ms | 188 / 192 ms |

The same test checks that the Rust and TypeScript tracers draw identical paths.

Against uPlot, a full view of 1M samples takes 2.6 ms instead of 97 (37×), and 10M takes 4.4 ms instead of
960 (220×). Zooming into 10M takes 3.2 ms instead of 128 (40×). A 24-panel dashboard redraws 4× faster. Only
tiny live views, where there is nothing to decimate, are still faster in uPlot under V8's JIT. The
TypeScript store alone beats uPlot from about 1M samples on, but it tops out at about 2 million samples.

## Develop

```sh
nsh run example                 # the dashboard, TypeScript store
nsh run perf                    # the dashboard, Rust store (builds the crate), up to 50M samples
nsh check example               # type check
nsh test example                # headless: store vs brute force, engine, scales, rendering, UI
nsh test perf                   # TypeScript vs Rust, and their paths compared
cargo test                      # the Rust crate on its own
cd bench/uplot && bun install && bun run.ts   # uPlot on the same scenarios, headless Chrome/Edge
```

## Roadmap

- More O11y panels on the same engine: histograms / heatmaps (latency distributions), bar and stacked area,
  a trace waterfall, a log-volume timeline with exemplars linking to traces.
- A second y axis.
- Keep the newest frame's paths in Rust and hand the canvas a native path handle instead of SVG text.

## License

[Apache License 2.0](LICENSE)
