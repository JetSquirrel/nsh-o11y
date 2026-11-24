/**
 * The TypeScript store next to the Rust one (`native/`, `nsh-o11y/native`), in NSH's own runtime
 * (QuickJS): loading, tracing a viewport, zooming, a live append, a dashboard frame. Prints a table.
 *
 *   nsh test perf
 */
import { OffscreenCanvas, Path2D } from "nsh";
import { describe, expect, test } from "nsh/test";
import * as native from "nsh-o11y/native";
import { ChartEngine } from "../src/chart";
import { setNativeBackend, createTimeSeries, type NativeBackend, type WritableSeriesStore } from "../src/native";
import { PALETTE_LIGHT } from "../src/palette";
import { renderOverlay, renderPlot, type Ctx2D } from "../src/render";
import type { ChartTheme } from "../src/types";
import { randomWalkChunks } from "../example/data";

const backend = native as unknown as NativeBackend;
setNativeBackend(backend);

const THEME: ChartTheme = {
  background: "#ffffff", text: "#111111", muted: "#666666", grid: "#00000022", cursor: "#00000088",
  selection: "#2563eb", surface: "#ffffff", palette: PALETTE_LIGHT, fontFamily: "system-ui", fontSize: 11,
};
const PATH = (d: string) => new Path2D(d);
const W = 1000;
const H = 300;

// NSH stops a call into JS after 2 s; microtasks count as the same call, so yield to a timer often.
let lastYield = Date.now();
async function breathe() {
  if (Date.now() - lastYield < 100) return;
  await new Promise((r) => setTimeout(r, 0));
  lastYield = Date.now();
}

/** Times `step` `n` times: mean and p95 ms. `performance.now()` resolves below a millisecond. */
async function timed(n: number, step: (i: number) => void) {
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    await breathe();
    const t0 = performance.now();
    step(i);
    ms.push(performance.now() - t0);
  }
  ms.sort((a, b) => a - b);
  return { mean: ms.reduce((s, v) => s + v, 0) / n, p95: ms[Math.min(n - 1, Math.floor(n * 0.95))] };
}

async function load(kind: "ts" | "rust", n: number): Promise<{ store: WritableSeriesStore; ms: number }> {
  const store = createTimeSeries({ backend: kind, capacity: kind === "ts" ? n : undefined });
  let ms = 0;
  await randomWalkChunks(n, (x, y) => {
    const t0 = performance.now();
    store.append(x, [y]);
    ms += performance.now() - t0;
  });
  lastYield = Date.now();
  return { store, ms };
}

function engineFor(store: WritableSeriesStore) {
  const e = new ChartEngine();
  e.setStore(store);
  e.setSeries([{ label: "v" }], PALETTE_LIGHT);
  e.setSize(W, H);
  return e;
}

const rows: string[] = [];
const fmt = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));

/** A frame as the chart draws it: update, trace and record the plot, then the overlay. */
async function frames(e: ChartEngine, n: number, before?: (i: number) => void) {
  const cx = new OffscreenCanvas(W, H).getContext("2d") as unknown as Ctx2D;
  e.measure = (t) => cx.measureText(t).width;
  return timed(n, (i) => {
    before?.(i);
    e.update();
    renderPlot(cx, e, THEME, PATH);
    renderOverlay(cx, e, THEME);
  });
}

describe("TypeScript and Rust", () => {
  for (const n of [100_000, 1_000_000, 10_000_000]) {
    test(`${n.toLocaleString()} samples: load, full view, zoom`, async () => {
      for (const kind of ["ts", "rust"] as const) {
        // 10M samples are 160 MB: past NSH's 256 MB JS heap once arrays grow, so only Rust holds them.
        if (kind === "ts" && n > 2_000_000) {
          rows.push(`| ${n.toLocaleString()} | TypeScript | out of memory (JS heap is 256 MB) | | | |`);
          continue;
        }
        const { store, ms } = await load(kind, n);
        expect(store.length()).toBe(n);
        const e = engineFor(store);
        const full = await frames(e, 20);
        // Zoom in step by step toward the middle, 1.25× a frame, as a wheel does.
        e.update();
        const mid = e.plot.left + e.plot.width / 2;
        const zoom = await frames(e, 30, () => e.zoomAt(1.25, mid));
        // Hover: the overlay alone.
        const cx = new OffscreenCanvas(W, H).getContext("2d") as unknown as Ctx2D;
        const hover = await timed(60, (i) => {
          e.setCursor(e.plot.left + (i * 13) % e.plot.width);
          renderOverlay(cx, e, THEME);
        });
        rows.push(
          `| ${n.toLocaleString()} | ${kind === "ts" ? "TypeScript" : "Rust"} | ${fmt(ms)} | ${fmt(full.mean)} / ${fmt(full.p95)} | ${fmt(zoom.mean)} / ${fmt(zoom.p95)} | ${fmt(hover.mean)} |`,
        );
        store.clear();
        await breathe();
      }
    }, 300_000);
  }

  test("live: 1 sample appended per frame, last 5 minutes at 10 Hz (3000 shown) of 1M kept", async () => {
    for (const kind of ["ts", "rust"] as const) {
      const store = createTimeSeries({ backend: kind, maxPoints: 1_000_000 });
      const { store: src } = await load("ts", 1_000_000);
      // Copy over in chunks.
      for (let i = 0; i < 1_000_000; i += 100_000) {
        const x = new Float64Array(100_000);
        const y = new Float64Array(100_000);
        for (let k = 0; k < 100_000; k++) {
          x[k] = src.x(i + k);
          y[k] = src.y(0, i + k);
        }
        store.append(x, [y]);
        await breathe();
      }
      src.clear();
      const e = engineFor(store);
      e.setOptions({ window: 300_000 });
      let t = store.x(store.length() - 1);
      const live = await frames(e, 120, () => {
        t += 100;
        store.append(t, [Math.random() * 100]);
      });
      rows.push(`| live, 1M kept, 3000 in view | ${kind === "ts" ? "TypeScript" : "Rust"} | | ${fmt(live.mean)} / ${fmt(live.p95)} | | |`);
    }
  }, 300_000);

  test("dashboard: 24 panels × 3 series × 20k samples", async () => {
    for (const kind of ["ts", "rust"] as const) {
      const engines: ChartEngine[] = [];
      for (let p = 0; p < 24; p++) {
        const store = createTimeSeries({ backend: kind, series: 3 });
        const ys: Float64Array[] = [];
        let x: Float64Array | null = null;
        for (let s = 0; s < 3; s++) {
          await randomWalkChunks(20_000, (cx, cy) => {
            x = cx;
            ys.push(cy);
          }, { seed: p * 3 + s + 1, chunk: 20_000 });
        }
        store.setData(x!, ys);
        const e = engineFor(store);
        e.setSeries([{ label: "a" }, { label: "b" }, { label: "c" }], PALETTE_LIGHT);
        e.setSize(400, 180);
        engines.push(e);
      }
      const cx = new OffscreenCanvas(400, 180).getContext("2d") as unknown as Ctx2D;
      for (const e of engines) e.measure = (t) => cx.measureText(t).width;
      const all = await timed(10, () => {
        for (const e of engines) {
          e.update();
          renderPlot(cx, e, THEME, PATH);
        }
      });
      rows.push(`| 24 panels × 3 × 20k | ${kind === "ts" ? "TypeScript" : "Rust"} | | ${fmt(all.mean)} / ${fmt(all.p95)} (all panels) | | |`);
    }
  }, 300_000);

  test("the Rust and TypeScript tracers draw the same paths", async () => {
    const ts = createTimeSeries({ backend: "ts" });
    const rs = createTimeSeries({ backend: "rust" });
    await randomWalkChunks(300_000, (x, y) => {
      ts.append(x, [y]);
      rs.append(x, [y]);
    }, { chunk: 30_000 });
    for (const [x0, x1] of [[ts.x(0), ts.x(299_999)], [ts.x(1000), ts.x(1500)], [ts.x(100_000), ts.x(160_000)]]) {
      for (const extra of [{}, { scale: 10 }, { baseline: 290 }, { step: true }, { spanGaps: true }]) {
        const o = { x0, x1, y0: 0, y1: 400, left: 40, top: 10, width: 777, height: 280, ...extra };
        expect(rs.trace(0, o)).toBe(ts.trace(0, o));
      }
    }
    expect(rs.extent(0, 123, 234_567)).toEqual(ts.extent(0, 123, 234_567));
  }, 120_000);

  test("report", () => {
    console.log(
      [
        "",
        "| Samples | Store | Load (ms) | Full-view frame, mean / p95 (ms) | Zooming frame, mean / p95 (ms) | Hover frame (ms) |",
        "|---|---|---|---|---|---|",
        ...rows,
      ].join("\n"),
    );
  });
});
