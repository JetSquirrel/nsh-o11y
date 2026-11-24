/**
 * One adapter per library, each set up as its docs recommend for large time series: animations off, no
 * point markers, its own decimation where it has one. Times are milliseconds everywhere; an adapter
 * converts to what its library wants in `prepare`, which is not timed.
 *
 * Every call that changes the view must have drawn by the time it returns (or its promise resolves), so
 * the bench can time it: uPlot's `batch`, ECharts' `zr.flush()`, Chart.js and Dygraphs draw synchronously
 * with animations off, Plotly's calls resolve after drawing, nsh-o11y draws in the call.
 */
import uPlot from "uplot";
import * as echarts from "echarts";
import Chart from "chart.js/auto";
import Dygraph from "dygraphs";
// @ts-ignore no types
import Plotly from "plotly.js-dist-min";
import { TimeSeries } from "../../../src/store";
import { ChartEngine } from "../../../src/chart";
import { renderOverlay, renderPlot, type Ctx2D } from "../../../src/render";
import { PALETTE_LIGHT } from "../../../src/palette";
import type { ChartTheme } from "../../../src/types";
import { META } from "./meta";

export interface Data {
  x: Float64Array;
  /** NaN is a missing value. */
  ys: Float64Array[];
}

export interface Live {
  /** Appends a sample, keeps about `keep`, shows [x0, x1], draws. */
  step(t: number, v: number, x0: number, x1: number): void | Promise<void>;
}

export interface Adapter {
  name: string;
  version: string;
  /** How it was set up, for the report. */
  setup: string;
  prepare(d: Data): any;
  create(el: HTMLElement, prepared: any, w: number, h: number): any | Promise<any>;
  /** Shows [x0, x1] and draws. */
  setX(h: any, x0: number, x1: number): void | Promise<void>;
  /** Moves the cursor to `px` within the plot and draws what that shows. */
  hover?(h: any, px: number): void;
  live(el: HTMLElement, d: Data, w: number, h: number, keep: number): Live | Promise<Live>;
  destroy(h: any): void;
  /** Why it can't run the dashboard, if it can't. */
  noDashboard?: string;
}

const COLORS = ["#2a78d6", "#eb6834", "#1baf7a"];
const nullify = (y: Float64Array) => {
  const a = new Array(y.length);
  for (let i = 0; i < y.length; i++) a[i] = y[i] === y[i] ? y[i] : null;
  return a;
};
const hhmm = (v: number) => new Date(v).toISOString().slice(11, 16);

function box(el: HTMLElement, w: number, h: number) {
  const d = document.createElement("div");
  d.className = "chart";
  d.style.width = `${w}px`;
  d.style.height = `${h}px`;
  el.appendChild(d);
  return d;
}

function canvas(el: HTMLElement, w: number, h: number, over = false) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.style.cssText = `width:${w}px;height:${h}px;${over ? "position:absolute;left:0;top:0" : ""}`;
  el.appendChild(c);
  return c;
}

// ---- nsh-o11y: the same TypeScript engine and renderer as in NSH, on the browser's Canvas 2D.

const THEME: ChartTheme = {
  background: "#ffffff", text: "#111111", muted: "#666666", grid: "#00000022", cursor: "#00000088",
  selection: "#2563eb", surface: "#ffffff", palette: PALETTE_LIGHT, fontFamily: "system-ui", fontSize: 11,
};

function nshChart(el: HTMLElement, store: TimeSeries, series: number, w: number, h: number) {
  const d = box(el, w, h);
  const cx = canvas(d, w, h).getContext("2d")! as unknown as Ctx2D & CanvasRenderingContext2D;
  const ox = canvas(d, w, h, true).getContext("2d")! as unknown as Ctx2D & CanvasRenderingContext2D;
  const e = new ChartEngine();
  e.setStore(store);
  e.setSeries(Array.from({ length: series }, (_, i) => ({ label: `s${i}` })), PALETTE_LIGHT);
  e.setSize(w, h);
  e.measure = (t) => cx.measureText(t).width;
  const path = (s: string) => new Path2D(s);
  const overlay = () => {
    ox.clearRect(0, 0, w, h);
    renderOverlay(ox, e, THEME);
  };
  const frame = () => {
    e.update();
    renderPlot(cx, e, THEME, path);
    overlay();
  };
  frame();
  return { e, frame, overlay, d, store };
}

export const nsh: Adapter = {
  ...META.nsh,
  prepare: (d) => d,
  create: (el, d: Data, w, h) => nshChart(el, TimeSeries.from(d.x, d.ys), d.ys.length, w, h),
  setX(h, x0, x1) {
    h.e.setXRange(x0, x1, false);
    h.frame();
  },
  hover(h, px) {
    h.e.setCursor(h.e.plot.left + px);
    h.overlay();
  },
  live(el, d, w, hh, keep) {
    const store = new TimeSeries({ maxPoints: keep });
    store.append(d.x, d.ys);
    const h = nshChart(el, store, 1, w, hh);
    h.e.setOptions({ window: 300_000 });
    return {
      step(t, v) {
        store.append(t, [v]);
        h.frame();
      },
    };
  },
  destroy: (h) => h.d.remove(),
};

// ---- uPlot

function uOpts(w: number, h: number, series: number): uPlot.Options {
  return {
    width: w,
    height: h,
    pxRatio: 1,
    legend: { show: true, live: true },
    cursor: { drag: { x: true, y: false } },
    scales: { x: { time: true } },
    series: [{}, ...Array.from({ length: series }, (_, i) => ({ label: `s${i}`, stroke: COLORS[i % 3], width: 1.5 }))],
    axes: [{}, {}],
  } as uPlot.Options;
}

export const uplot: Adapter = {
  ...META.uplot,
  // uPlot's x is in seconds when `time` is on; it reads null as a gap.
  prepare: (d) => [Float64Array.from(d.x, (v) => v / 1000), ...d.ys.map(nullify)],
  create(el, data, w, h) {
    const d = box(el, w, h + 30);
    const u = new uPlot(uOpts(w, h, data.length - 1), data, d);
    u.batch(() => {});
    return { u, d };
  },
  setX: (h, x0, x1) => h.u.batch(() => h.u.setScale("x", { min: x0 / 1000, max: x1 / 1000 })),
  hover: (h, px) => h.u.setCursor({ left: px, top: 100 }),
  live(el, d, w, hh, keep) {
    const xs = Array.from(d.x, (v) => v / 1000);
    const y = nullify(d.ys[0]);
    const data = [xs, y];
    const u = new uPlot(uOpts(w, hh, 1), data as any, box(el, w, hh + 30));
    return {
      step(t, v, x0, x1) {
        xs.push(t / 1000);
        y.push(v);
        // No ring buffer: drop from the front in batches.
        if (xs.length > keep + keep / 8) {
          xs.splice(0, xs.length - keep);
          y.splice(0, y.length - keep);
        }
        u.batch(() => {
          u.setData(data as any, false);
          u.setScale("x", { min: x0 / 1000, max: x1 / 1000 });
        });
      },
    };
  },
  destroy(h) {
    h.u.destroy();
    h.d.remove();
  },
};

// ---- ECharts

function eOption(series: any[]): echarts.EChartsOption {
  return {
    animation: false,
    grid: { left: 50, right: 12, top: 12, bottom: 28 },
    tooltip: { trigger: "axis", animation: false, transitionDuration: 0 } as any,
    xAxis: { type: "time" },
    yAxis: { type: "value", scale: true },
    // Zooming as ECharts does it: an inside dataZoom that filters the data to the window.
    dataZoom: [{ type: "inside", filterMode: "filter", throttle: 0 }],
    series: series.map((data, i) => ({
      type: "line",
      data,
      dimensions: ["x", "y"],
      encode: { x: "x", y: "y" },
      showSymbol: false,
      symbol: "none",
      sampling: "lttb",
      lineStyle: { width: 1.5, color: COLORS[i % 3] },
      emphasis: { disabled: true },
    })),
  };
}

export const echart: Adapter = {
  ...META.echarts,
  // A flat typed array: ECharts' compact input for big series (no array per point).
  prepare: (d) =>
    d.ys.map((y) => {
      const f = new Float64Array(d.x.length * 2);
      for (let i = 0; i < d.x.length; i++) {
        f[2 * i] = d.x[i];
        f[2 * i + 1] = y[i];
      }
      return f;
    }),
  create(el, flats, w, h) {
    const d = box(el, w, h);
    const c = echarts.init(d, null, { renderer: "canvas", width: w, height: h, devicePixelRatio: 1 });
    c.setOption(eOption(flats));
    c.getZr().flush();
    return { c, d };
  },
  setX(h, x0, x1) {
    h.c.dispatchAction({ type: "dataZoom", startValue: x0, endValue: x1 });
    h.c.getZr().flush();
  },
  hover(h, px) {
    h.c.dispatchAction({ type: "showTip", x: 50 + px, y: 100 });
    h.c.getZr().flush();
  },
  live(el, d, w, hh, keep) {
    const pairs: number[][] = new Array(d.x.length);
    for (let i = 0; i < d.x.length; i++) pairs[i] = [d.x[i], d.ys[0][i]];
    const dv = box(el, w, hh);
    const c = echarts.init(dv, null, { renderer: "canvas", width: w, height: hh, devicePixelRatio: 1 });
    c.setOption(eOption([pairs]));
    c.getZr().flush();
    return {
      step(t, v, x0, x1) {
        pairs.push([t, v]);
        if (pairs.length > keep + keep / 8) pairs.splice(0, pairs.length - keep);
        c.setOption({ series: [{ data: pairs }], dataZoom: [{ startValue: x0, endValue: x1 }] });
        c.getZr().flush();
      },
    };
  },
  destroy(h) {
    h.c.dispose();
    h.d.remove();
  },
};

// ---- Chart.js

function cConfig(datasets: any[]): any {
  return {
    type: "line",
    data: {
      datasets: datasets.map((data, i) => ({
        data,
        borderColor: COLORS[i % 3],
        borderWidth: 1.5,
        pointRadius: 0,
        spanGaps: false,
        parsing: false,
        normalized: true,
      })),
    },
    options: {
      animation: false,
      responsive: false,
      devicePixelRatio: 1,
      parsing: false,
      normalized: true,
      events: [],
      interaction: { mode: "index", intersect: false },
      plugins: {
        // Chart.js's own decimation: the min and max of each pixel column.
        decimation: { enabled: true, algorithm: "min-max" },
        legend: { display: false },
        tooltip: { enabled: true, animation: false },
      },
      scales: {
        x: { type: "linear", ticks: { callback: hhmm, maxRotation: 0 } },
        y: { type: "linear" },
      },
    },
  };
}

export const chartjs: Adapter = {
  ...META.chartjs,
  prepare: (d) =>
    d.ys.map((y) => {
      const a = new Array(d.x.length);
      for (let i = 0; i < d.x.length; i++) a[i] = { x: d.x[i], y: y[i] === y[i] ? y[i] : null };
      return a;
    }),
  create(el, sets, w, h) {
    const d = box(el, w, h);
    const ch = new Chart(canvas(d, w, h), cConfig(sets));
    return { ch, d };
  },
  setX(h, x0, x1) {
    h.ch.options.scales.x.min = x0;
    h.ch.options.scales.x.max = x1;
    h.ch.update("none");
  },
  hover(h, px) {
    const ch = h.ch;
    const at = { native: null, type: "mousemove", x: ch.chartArea.left + px, y: 100 };
    const els = ch.getElementsAtEventForMode(at, "index", { intersect: false }, false);
    ch.setActiveElements(els);
    ch.tooltip.setActiveElements(els, { x: at.x, y: at.y });
    ch.render();
  },
  live(el, d, w, hh, keep) {
    const pts = chartjs.prepare({ x: d.x, ys: [d.ys[0]] })[0];
    const ch = new Chart(canvas(box(el, w, hh), w, hh), cConfig([pts]));
    return {
      step(t, v, x0, x1) {
        pts.push({ x: t, y: v });
        if (pts.length > keep + keep / 8) pts.splice(0, pts.length - keep);
        ch.options.scales.x.min = x0;
        ch.options.scales.x.max = x1;
        ch.update("none");
      },
    };
  },
  destroy(h) {
    h.ch.destroy();
    h.d.remove();
  },
};

// ---- Plotly

const pLayout = (w: number, h: number) => ({
  width: w,
  height: h,
  margin: { l: 50, r: 10, t: 10, b: 30 },
  xaxis: { type: "date" },
  yaxis: { autorange: true },
  showlegend: false,
  hovermode: "x",
});
const pTraces = (x: any, ys: any[]) =>
  ys.map((y, i) => ({ type: "scattergl", mode: "lines", x, y, line: { width: 1.5, color: COLORS[i % 3] } }));

export const plotly: Adapter = {
  ...META.plotly,
  prepare: (d) => d,
  async create(el, d: Data, w, h) {
    const dv = box(el, w, h);
    await Plotly.newPlot(dv, pTraces(d.x, d.ys), pLayout(w, h), { displayModeBar: false, responsive: false });
    return { dv };
  },
  setX: (h, x0, x1) => Plotly.relayout(h.dv, { "xaxis.range": [x0, x1], "yaxis.autorange": true }),
  async live(el, d, w, hh, keep) {
    const dv = box(el, w, hh);
    await Plotly.newPlot(dv, pTraces(Array.from(d.x), [Array.from(d.ys[0])]), pLayout(w, hh), {
      displayModeBar: false,
      responsive: false,
    });
    return {
      async step(t, v, x0, x1) {
        await Plotly.extendTraces(dv, { x: [[t]], y: [[v]] }, [0], keep);
        await Plotly.relayout(dv, { "xaxis.range": [x0, x1], "yaxis.autorange": true });
      },
    };
  },
  destroy(h) {
    Plotly.purge(h.dv);
    h.dv.remove();
  },
  noDashboard: "24 WebGL plots: browsers keep about 16 WebGL contexts alive",
};

// ---- Dygraphs

function dRows(d: Data) {
  const rows = new Array(d.x.length);
  for (let i = 0; i < d.x.length; i++) {
    const r = [d.x[i]];
    for (const y of d.ys) r.push(y[i] === y[i] ? y[i] : (null as any));
    rows[i] = r;
  }
  return rows;
}
const dOpts = (w: number, h: number, series: number) => ({
  width: w,
  height: h,
  labels: ["t", ...Array.from({ length: series }, (_, i) => `s${i}`)],
  colors: COLORS.slice(0, series),
  strokeWidth: 1.5,
  animatedZooms: false,
  legend: "never" as const,
  axes: { x: { axisLabelFormatter: (v: any) => hhmm(+v) } },
});

export const dygraphs: Adapter = {
  ...META.dygraphs,
  prepare: dRows,
  create(el, rows, w, h) {
    const d = box(el, w, h);
    const g = new Dygraph(d, rows, dOpts(w, h, rows[0].length - 1));
    return { g, d };
  },
  setX: (h, x0, x1) => h.g.updateOptions({ dateWindow: [x0, x1] }),
  hover(h, px) {
    const g = h.g;
    const row = g.findClosestRow(g.getArea().x + px);
    if (row >= 0) g.setSelection(row);
  },
  live(el, d, w, hh, keep) {
    const rows = dRows({ x: d.x, ys: [d.ys[0]] });
    const g = new Dygraph(box(el, w, hh), rows, dOpts(w, hh, 1));
    return {
      step(t, v, x0, x1) {
        rows.push([t, v]);
        if (rows.length > keep + keep / 8) rows.splice(0, rows.length - keep);
        g.updateOptions({ file: rows, dateWindow: [x0, x1] });
      },
    };
  },
  destroy(h) {
    h.g.destroy();
    h.d.remove();
  },
};

export const adapters: Record<string, Adapter> = { nsh, uplot, echarts: echart, chartjs, plotly, dygraphs };
