/**
 * Logs, traces, profiles and heatmaps in NSH's own runtime (QuickJS): building each model, a frame of each
 * view, and the live paths. Prints a table.
 *
 *   nsh test perf/telemetry.test.ts
 */
import { OffscreenCanvas, Path2D } from "nsh";
import { describe, expect, test } from "nsh/test";
import { HeatmapEngine, HeatmapStore, renderHeatmap, renderHeatmapOverlay } from "../src/distribution";
import { FlameEngine, renderFlame, renderFlameOverlay } from "../src/flame";
import { LogStore, LOG_LEVELS, type LogEntry } from "../src/logs";
import { LogVolumeEngine, renderLogVolume } from "../src/logvolume";
import { PALETTE_LIGHT } from "../src/palette";
import { profileFromFolded, profileFromFoldedAsync } from "../src/profile";
import type { Ctx2D } from "../src/render";
import { TraceModel, type Span } from "../src/traces";
import type { ChartTheme } from "../src/types";
import { renderWaterfall, renderWaterfallOverlay, WaterfallEngine } from "../src/waterfall";
import { rng } from "../example/data";

const THEME: ChartTheme = {
  background: "#ffffff", text: "#111111", muted: "#666666", grid: "#00000022", cursor: "#00000088",
  selection: "#2563eb", surface: "#ffffff", palette: PALETTE_LIGHT, fontFamily: "system-ui", fontSize: 11,
};
const PATH = (d: string) => new Path2D(d);
const ctx = (w: number, h: number) => new OffscreenCanvas(w, h).getContext("2d") as unknown as Ctx2D;

// NSH stops a call into JS after 2 s: yield to a timer often.
let lastYield = Date.now();
async function breathe() {
  if (Date.now() - lastYield < 100) return;
  await new Promise((r) => setTimeout(r, 0));
  lastYield = Date.now();
}

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

async function once(step: () => void) {
  await breathe();
  const t0 = performance.now();
  step();
  return performance.now() - t0;
}

const rows: string[] = [];
const fmt = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
const row = (what: string, size: string, r: { mean: number; p95: number } | number) =>
  rows.push(`| ${what} | ${size} | ${typeof r === "number" ? `${fmt(r)} ms` : `${fmt(r.mean)} / ${fmt(r.p95)} ms`} |`);

const WORDS = ["timeout calling payment", "order placed", "cache hit", "retrying charge", "slow query", "GET /api/cart 200", "connection reset"];
const SERVICES = ["frontend", "checkout", "payment", "inventory", "cart"];

async function logLines(n: number): Promise<LogEntry[]> {
  const r = rng(1);
  const out: LogEntry[] = new Array(n);
  let t = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    if (i % 20_000 === 0) await breathe();
    t += Math.floor(r() * 40);
    out[i] = {
      time: t,
      level: LOG_LEVELS[Math.floor(r() * r() * 6)],
      message: `${WORDS[Math.floor(r() * WORDS.length)]} id=${i}`,
      service: SERVICES[Math.floor(r() * SERVICES.length)],
      attributes: { host: `web-${1 + (i % 4)}` },
    };
  }
  return out;
}

function spans(n: number): Span[] {
  const r = rng(2);
  const out: Span[] = [{ spanId: "s0", name: "root", service: "svc0", start: 0, duration: n * 2 }];
  for (let i = 1; i < n; i++) {
    const p = out[Math.floor(r() * Math.min(i, 1 + i * 0.3))];
    const start = p.start + r() * p.duration * 0.8;
    out.push({ spanId: `s${i}`, parentId: p.spanId, name: `op ${i % 300}`, service: `svc${i % 9}`, start, duration: (p.start + p.duration - start) * r(), status: r() < 0.02 ? "error" : "ok" });
  }
  return out;
}

/** Folded stacks of a wide, deep program: `stacks` distinct stacks of up to `depth` frames. */
async function folded(stacks: number, depth: number) {
  const r = rng(3);
  let s = "";
  for (let i = 0; i < stacks; i++) {
    if (i % 5000 === 0) await breathe();
    const d = 3 + Math.floor(r() * depth);
    const frames: string[] = [];
    for (let k = 0; k < d; k++) frames.push(`pkg${k % 7}.fn${Math.floor(r() * r() * (8 + k * 6))}`);
    s += `${frames.join(";")} ${1 + Math.floor(r() * 20)}\n`;
  }
  return s;
}

const print = () => console.log(["", "| What | Size | Time (mean / p95, or once) |", "|---|---|---|", ...rows.splice(0)].join("\n"));

describe("telemetry in QuickJS", () => {
  test("logs", async () => {
    for (const n of [50_000, 200_000]) {
      const lines = await logLines(n);
      let store!: LogStore;
      row("LogStore: load", n.toLocaleString(), await once(() => (store = LogStore.from(lines))));
      const [t0, t1] = store.extent()!;
      row("query: all", n.toLocaleString(), await timed(10, () => store.query({ levels: ["warn", "error", "fatal", "info"], from: t0 + (store.version++ % 2) })));
      // The first text search lowers every line once; later ones reuse it.
      row("query: text, first", n.toLocaleString(), await once(() => store.query({ text: "payment" })));
      row("query: text, again", n.toLocaleString(), await timed(10, (i) => store.query({ text: i % 2 ? "payment" : "slow" })));
      row("level counts", n.toLocaleString(), await timed(10, () => store.levelCounts({ from: t0 + (store.version++ % 2) })));
      const vol = new LogVolumeEngine();
      vol.setSize(1000, 96);
      const cx = ctx(1000, 96);
      vol.measure = (t) => cx.measureText(t).width;
      row("histogram frame", n.toLocaleString(), await timed(20, () => {
        vol.update(store, {}, t0, t1);
        renderLogVolume(cx, vol, THEME, PATH);
      }));
      // Live: a few lines arrive, the list and the histogram follow.
      let shown = store.query({}).length;
      let rowsShown: LogEntry[] = store.query({}).map((i) => store.get(i)).reverse();
      row("live: 6 lines, list + histogram", n.toLocaleString(), await timed(20, (i) => {
        const at = t1 + i * 200;
        store.append([0, 1, 2, 3, 4, 5].map((k) => ({ time: at + k, level: "info" as const, message: "live", service: "frontend" })));
        // As LogView does: the new lines, newest first, joined in front of the rows it has.
        const idx = store.query({});
        const add: LogEntry[] = [];
        for (let k = idx.length - 1; k >= shown; k--) add.push(store.get(idx[k]));
        rowsShown = add.concat(rowsShown);
        shown = idx.length;
        store.levelCounts({});
        vol.update(store, {}, t0, at);
        renderLogVolume(cx, vol, THEME, PATH);
      }));
    }
    expect(rows.length).toBeGreaterThan(0);
    print();
  }, 300_000);

  test("traces", async () => {
    for (const n of [1_000, 10_000, 50_000]) {
      const sp = spans(n);
      let m!: TraceModel;
      row("TraceModel: build + rows", `${n.toLocaleString()} spans`, await once(() => {
        m = new TraceModel(sp);
        m.rows();
      }));
      const e = new WaterfallEngine();
      const cx = ctx(1000, 600);
      e.measure = (t) => cx.measureText(t).width;
      e.setSize(1000, 600);
      row("waterfall: model + critical path", `${n.toLocaleString()} spans`, await once(() => e.setModel(m, PALETTE_LIGHT)));
      e.setRows(m.rows());
      row("waterfall: first frame (overview made)", `${n.toLocaleString()} spans`, await once(() => renderWaterfall(cx, e, THEME, PATH)));
      row("waterfall: scroll frame", `${n.toLocaleString()} spans`, await timed(20, (i) => {
        e.scrollBy(i % 2 ? -300 : 330);
        renderWaterfall(cx, e, THEME, PATH);
      }));
      row("waterfall: hover", `${n.toLocaleString()} spans`, await timed(20, (i) => {
        e.hover = 3 + (i % 10);
        e.pointer = { x: 700, y: 200 };
        renderWaterfallOverlay(cx, e, THEME);
      }));
    }
    print();
  }, 300_000);

  test("profiles", async () => {
    for (const n of [5_000, 20_000]) {
      const text = await folded(n, 24);
      let p!: ReturnType<typeof profileFromFolded>;
      row("profileFromFolded", `${n.toLocaleString()} stacks`, await once(() => (p = profileFromFolded(text))));
      const e = new FlameEngine();
      const cx = ctx(1000, 600);
      e.setRoot(p);
      e.setSize(1000, 600);
      row("flame frame (layout + draw)", `${n.toLocaleString()} stacks`, await timed(10, () => {
        e.layout();
        renderFlame(cx, e, THEME, PATH);
      }));
      row("flame: zoom + frame", `${n.toLocaleString()} stacks`, await timed(10, (i) => {
        e.zoomTo(i % 2 ? p : p.children[0]);
        e.layout();
        renderFlame(cx, e, THEME, PATH);
      }));
      row("flame: hover", `${n.toLocaleString()} stacks`, await timed(20, (i) => {
        e.hover = e.frameAt(100 + i * 30, 40);
        e.pointer = { x: 100 + i * 30, y: 40 };
        renderFlameOverlay(cx, e, THEME);
      }));
    }
    print();
  }, 300_000);

  test("a big profile, parsed in slices", async () => {
    // Past what one call into JS may take (2 s): the async parse yields between slices of lines.
    const text = await folded(50_000, 24);
    const t0 = performance.now();
    let slices = 0;
    const p = await profileFromFoldedAsync(text, { onProgress: () => slices++ });
    row("profileFromFoldedAsync (in 2000-line slices)", "50,000 stacks", performance.now() - t0);
    rows.push(`| … slices, the longest call into JS ≈ one slice | ${slices} | |`);
    expect(p.children.length).toBeGreaterThan(0);
    print();
  }, 300_000);

  test("heatmap", async () => {
    const s = new HeatmapStore({ step: 1000, min: 5, max: 5000, buckets: 48, maxColumns: 3600 });
    const r = rng(4);
    const vals = new Float64Array(200);
    // Values made ahead, so only the store's work is timed: a second of 200 observations at a time.
    const batches: Float64Array[] = [];
    for (let b = 0; b < 60; b++) {
      const v = new Float64Array(200);
      for (let k = 0; k < v.length; k++) v[k] = 40 * Math.exp(0.6 * (r() + r() + r() - 1.5) * 2);
      batches.push(v);
    }
    let addMs = 0;
    for (let t = 0; t < 3_600_000; t += 1000) {
      if (t % 60_000 === 0) await breathe();
      const t0 = performance.now();
      s.add(t, batches[(t / 1000) % 60]);
      if (t % 3000 === 0) s.addExemplar({ time: t, value: batches[0][(t / 1000) % 200], id: `t${t}` });
      addMs += performance.now() - t0;
    }
    row("HeatmapStore: add 1 h, 200 obs/s", "720,000 obs", addMs);
    row("HeatmapStore: add 1 s of 200 obs (live)", "", addMs / 3600);
    void vals;
    const e = new HeatmapEngine();
    e.store = s;
    const cx = ctx(1000, 300);
    e.measure = (t) => cx.measureText(t).width;
    e.setSize(1000, 300);
    for (const [label, span] of [["5 min", 300_000], ["1 h", 3_600_000]] as const) {
      row("heatmap frame", label, await timed(10, () => {
        e.update(3_600_000 - span, 3_600_000);
        renderHeatmap(cx, e, THEME, PATH);
      }));
    }
    row("heatmap: hover", "1 h", await timed(20, (i) => {
      e.hover = e.cellAt(100 + i * 40, 150);
      e.hoverExemplar = e.exemplarAt(100 + i * 40, 150);
      e.pointer = { x: 100 + i * 40, y: 150 };
      renderHeatmapOverlay(cx, e, THEME);
    }));
    print();
  }, 300_000);
});
