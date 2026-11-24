# nsh-o11y

Observability charts for [Native Shell (NSH)](https://nsh.dev), written in TSX, with an optional Rust backend
for large data. Its core is `TimeSeriesChart`, built to beat [uPlot](https://github.com/leeoniya/uPlot), ECharts and Chart.js
where native O11y dashboards need it: millions of points, zooming, live data, many panels. Around it are the
other three signals: `LogView` (a log-volume histogram over a virtualized, filterable log list),
`TraceWaterfall` (one trace's spans as a tree of bars) and `FlameGraph` (a CPU or allocation profile). Everything
draws on NSH's native `<Canvas>`, so it runs on every NSH platform, and ships as an nshm, laid out like
[nsh-graph](../nsh-graph).

**[Site and live demo](https://jetsquirrel.github.io/nsh-o11y/)**: the example dashboard, built with `nsh package --target web`
(TypeScript store; drag to zoom, wheel to zoom, double-click to reset).

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

## Heatmap

```tsx
import { Heatmap, HeatmapStore } from "nsh-o11y";

const latency = new HeatmapStore({ step: 1000, min: 5, max: 5000, buckets: 48, maxColumns: 600 });
latency.add(Date.now(), requestDurationMs);          // one observation, or an array of them

<Heatmap data={latency} unit="ms" window={5 * 60_000} sync={sync} style={{ flex: 1 }} />
```

Percentile lines say p99 rose; a heatmap shows why. It might be a second band of slow requests, or everything
shifting up. Each column is `step` ms. Each row is a bucket of values, log-spaced by default, so latencies from
milliseconds to seconds get equal room. A cell's color is its count on a log scale. Percentile lines (`percentiles`,
default p50 and p99) are read from the buckets. Hover a cell for its count, its share of the column and the
column's percentiles. With `sync`, the heatmap shares the crosshair with linked charts and follows their zoom.
`addCounts(t, counts)` takes pre-bucketed histograms. In the example, the Latency panel switches to a heatmap,
and the incident shows as a separate band at about 1 s that the p99 line jumps to.

## Logs, traces and profiles

The example's **Logs**, **Traces** and **Profiles** tabs show all three components with the metrics: a log line's
trace id opens its trace.

### `LogView`

```tsx
import { LogStore, LogView } from "nsh-o11y";

const logs = new LogStore({ maxEntries: 50_000 });
logs.append({ time: Date.now(), level: "error", message: "charge failed", service: "payment", traceId });

<LogView data={logs} window={5 * 60_000} onTraceClick={(id) => openTrace(id)} style={{ flex: 1 }} />
```

The view has level toggles with counts, a search box (message, service and attributes, case-insensitive), a
stacked histogram of volume per level, and the lines newest first in a virtualized `List`. Drag across the histogram
or tap a bar to narrow the list to that time; double-tap to show everything again. Press a line to see its
attributes and its trace link. Lines may arrive a little out of order, and the oldest are dropped past `maxEntries`.
Props: `data` (a `LogStore` or `LogEntry[]`), `levels`, `search`, `toolbar`, `histogram`, `histogramHeight`,
`order` (`"newest"` / `"oldest"`), `window`, `timeZone`, `levelColors`, `onSelect`, `onTraceClick`,
`onRangeChange`.

`LogStore` works without NSH: `query(filter)`, `levelCounts(filter)` and `histogram(t0, t1, step, filter)` take a
filter of `{ levels, text, from, to }`.

### `TraceWaterfall`

```tsx
import { TraceWaterfall, type Span } from "nsh-o11y";

const spans: Span[] = [
  { spanId: "a", name: "POST /checkout", service: "frontend", start: 0, duration: 84 },
  { spanId: "b", parentId: "a", name: "PaymentService.Charge", service: "payment", start: 31, duration: 41, status: "error" },
];
<TraceWaterfall spans={spans} onSelect={(span) => showDetails(span)} style={{ flex: 1 }} />
```

Each span gets a row: its name indented under its parent, and a bar colored by service. Error spans are
outlined in red, the critical path is underlined, and span events are diamonds on the bars (red for exceptions;
the tooltip lists them). A controlled `selected` scrolls its row into view. Press a row to select it, or its triangle to fold its
children. Drag across the timeline to zoom, Ctrl/⌘ + scroll to zoom, scroll through the rows, Shift + scroll to
pan, double-click to zoom out. Above the time axis, an overview shows every span of the trace (folded or not)
with the range in view outlined: drag across it to zoom to a range, tap it to move there (`minimap={false}` hides it).
↑/↓ select, ←/→ fold, 0 zooms out. Only the rows in view are drawn: in the test,
a trace of 10,000 spans draws under 100 labels. Props: `spans` (a `Span[]` or a `TraceModel`), `rowHeight`,
`labelWidth`, `criticalPath`, `collapsed`, `selected`, `onSelect`. `TraceModel` gives the rows, each span's
self time and the critical path, headless.

### `FlameGraph`

```tsx
import { FlameGraph, profileFromFolded } from "nsh-o11y";

const profile = profileFromFolded("main;handle;parse 42\nmain;handle;render 17\n");   // flamegraph.pl's format
<FlameGraph profile={profile} unit="short" style={{ flex: 1 }} />
```

Each frame is as wide as the samples spent in it and in the functions it calls. Frames are colored by module, with
the root at the top (`direction="up"` puts it at the bottom). Press a frame to zoom to it: its callers stay
above, dimmed. Use the crumbs, Escape or a double-click to zoom back out. From the keyboard, the arrows walk the
frames (toward the root, to the biggest callee, and along a row), Enter zooms to the outlined frame, Backspace goes
up a level, and screen readers hear the frame's name, total and self. Pressing any chart gives it the keyboard.
Searching greys out frames that don't
match and shows the share of samples that do. Frames under a third of a point wide are never laid out, so
very large profiles stay quick. `profileFromStacks`, `profileFromTree`, `topFunctions` (self and total per
function, recursion counted once) and `matchedValue` work headless. Props: `profile` (a `ProfileNode`, folded
text, or `{ name, value?, children? }`), `unit`, `direction`, `rowHeight`, `colorBy` (`"module"` / `"name"`),
`toolbar`, `highlight`, `onSelect`, and `baseline`: a profile to compare with. Then the graph is a diff, as
`diffProfiles(before, after)` makes it: the new profile's shape, each frame red where its share of the profile grew and
blue where it shrank (changes under a quarter of a point stay neutral: sampling noise), and the tooltip gives both
shares. The example compares v2.14 with v2.13 and shows the pricing regression.

`<SandwichView profile={profile} fn="runtime.mallocgc" />` puts one function between what called it (a flame
growing up into it, from every call site) and what it called (its subtrees from every call, merged): the frames
scattered across the full graph read as two trees. `sandwichProfile(root, name)` gives both halves headless,
recursion counted once. In the example, the Sandwich view shows the function picked in the top-functions table.

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
  theme.ts            the theme from NSH's tokens, shared by every component
  draw.ts             canvas helpers: text cut to fit, tooltips, rectangles batched by color
  logs.ts             LogStore: lines in time order, filters, level counts, the volume histogram
  logvolume.ts        the histogram's engine and renderer
  LogView.tsx         the log explorer component
  traces.ts           TraceModel: spans as a tree, waterfall rows, self time, the critical path
  waterfall.ts        the waterfall's engine and renderer
  TraceWaterfall.tsx  the waterfall component
  profile.ts          call trees from folded stacks, stacks or trees; top functions; search
  flame.ts            the flame graph's engine and renderer
  FlameGraph.tsx      the flame graph component
  SandwichView.tsx    a function between its callers and callees
  distribution.ts     HeatmapStore: observations bucketed over time and value, quantiles; its engine and renderer
  Heatmap.tsx         the heatmap component
native/src/
  lib.rs              the native module: SeriesBuffer
  lod.rs              the pyramid and the tracer in Rust
example/              a service dashboard (metrics, logs, traces, a profile), tests
perf/                 the same dashboard with the Rust backend; TypeScript vs Rust benchmark
bench/web/            uPlot, ECharts, Chart.js, Plotly, Dygraphs and nsh-o11y in a headless browser
```

On QuickJS, which runs TSX on every NSH platform except the web, per-call costs dominate. So a series is one
`Path2D` built from SVG path data, not thousands of `lineTo` calls, and its coordinates are integers in tenths of
a point, drawn under `scale(0.1)`, which is faster to write and parse than decimals. Each column's samples are
found by galloping from where an even spread would put them, not by a full binary search.

## Performance

Each figure is the JavaScript time of one frame on a 1000 × 300 plot with one series, mean / p95, on a
4-core Windows Server VM. [bench/README.md](bench/README.md) has the method and each library's setup.

### Against other libraries, in the same browser

nsh-o11y's TypeScript engine on the browser's Canvas 2D, next to uPlot, ECharts, Chart.js, Plotly and
Dygraphs, each set up as its docs recommend for big series, each run in a fresh headless Edge 158
(`bench/web`).

**Full-view frame**: the whole series on screen, recomputed (a pan, a resize, new data):

| Library | 100k | 1M | 10M |
|---|---|---|---|
| **nsh-o11y** 0.1.0 | **2.2 ms** | **3.0 ms** | **3.5 ms** |
| uPlot 1.6.32 | 4.5 ms | 34 ms | 226 ms |
| ECharts 6.1.0 (LTTB sampling) | 10.3 ms | 31 ms | 180 ms |
| Chart.js 4.6.2 (min-max decimation) | 7.5 ms | 33 ms | 171 ms |
| Plotly 4.3.0 (`scattergl`, WebGL)¹ | 18.7 ms | 18 ms | 14.5 ms |
| Dygraphs 2.2.2 | 44 ms | 359 ms | 7553 ms |

**Zooming in** (a wheel, 1.25× a frame) and **creating the chart** (the first draw included):

| Library | Zoom, 1M | Zoom, 10M | Create, 1M | Create, 10M |
|---|---|---|---|---|
| **nsh-o11y** | **2.1 ms** | **2.4 ms** | **49 ms** | **246 ms** |
| uPlot | 6.1 ms | 28.5 ms | 90 ms | 268 ms |
| ECharts | 24 ms | 143 ms | 152 ms | 628 ms |
| Chart.js | 57 ms | 27 ms | 93 ms | 335 ms |
| Plotly¹ | 35 ms | 55 ms | 2351 ms | 14308 ms |
| Dygraphs | 81 ms | 2862 ms | 1018 ms | 10396 ms |

**Live and dashboards**:

| Library | Live: 1M kept, 3000 in view, 1 sample appended | Dashboard: 24 panels × 3 series × 20k | Hover, 1M |
|---|---|---|---|
| **nsh-o11y** | **0.41 / 0.60 ms** | **31 / 41 ms** | 0.08 ms |
| uPlot | 0.43 / 0.60 ms | 75 / 95 ms | 0.07 ms |
| ECharts | 1073 / 1458 ms | 152 / 192 ms | 3.6 ms |
| Chart.js | 124 / 183 ms | 176 / 211 ms | 1.3 ms |
| Plotly¹ | 1785 / 2544 ms | can't: ~16 WebGL contexts per page | not timed |
| Dygraphs | 46 / 156 ms | 531 / 852 ms | 12.9 ms |

nsh-o11y's frame barely grows with the data: at 10M samples it is 50–65× faster than uPlot, ECharts and
Chart.js on a full view, and 12× faster than uPlot when zooming. The others either draw every point in
view (uPlot, Dygraphs) or decimate by walking every point in view each frame (ECharts' LTTB, Chart.js's
min-max); nsh-o11y reads each pixel column's min and max from its pyramid. ECharts', Chart.js's and
Plotly's live frames are slow because they re-ingest the whole 1M-sample dataset on every update.

¹ Plotly draws on the GPU: once its 14 s upload is done, a frame mostly moves a camera, and the GPU's work
isn't in the JavaScript time. All of the full figures are in `bench/results/web.md` after a run.

### In NSH

In NSH's own runtime (QuickJS, interpreted), with the TypeScript store and the Rust one (`nsh test perf`):

| Samples | Store | Load | Full-view frame | Zooming frame | Hover |
|---|---|---|---|---|---|
| 100,000 | TypeScript | 26 ms | 14.2 / 30.6 ms | 6.5 / 14.6 ms | 0.07 ms |
| 100,000 | Rust | 6.6 ms | 1.8 / 3.1 ms | 0.84 / 1.7 ms | 0.30 ms |
| 1,000,000 | TypeScript | 1324 ms | 20.2 / 51 ms | 9.6 / 12.4 ms | 0.07 ms |
| 1,000,000 | Rust | 79 ms | 2.6 / 3.1 ms | 1.0 / 2.3 ms | 0.04 ms |
| 10,000,000 | TypeScript | out of memory (256 MB JS heap) | | | |
| 10,000,000 | Rust | 1277 ms | 4.4 / 7.4 ms | 3.2 / 4.6 ms | 0.48 ms |

| | TypeScript | Rust |
|---|---|---|
| Live (1M kept, 3000 in view) | 2.1 / 6.9 ms | 0.94 / 3.0 ms |
| Dashboard (24 panels × 3 × 20k) | 491 / 560 ms | 46 / 78 ms |

QuickJS interprets what V8 compiles, so the TypeScript store is about 7× slower here than in a browser;
the Rust store brings an NSH app back to browser speed or better (4.4 ms for a full view of 10M samples),
and past the 256 MB JS heap. The same test checks that the Rust and TypeScript tracers draw identical paths.

## Develop

```sh
nsh run example                 # the dashboard, TypeScript store
nsh run perf                    # the dashboard, Rust store (builds the crate), up to 50M samples
nsh check example               # type check
nsh test example                # headless: store vs brute force, engine, scales, rendering, UI
nsh test perf                   # TypeScript vs Rust, and their paths compared
cargo test                      # the Rust crate on its own
cd bench/web && bun install && bun run.ts     # every library on the same scenarios, headless Chrome/Edge
```

## Roadmap

- More O11y panels on the same engine: bar and stacked area, exemplars on heatmaps and time series linking to
  traces.
- Traces: comparing two traces.
- Logs in the Rust backend, for tens of millions of lines.
- A second y axis.
- Keep the newest frame's paths in Rust and hand the canvas a native path handle instead of SVG text.

## License

[Apache License 2.0](LICENSE)
