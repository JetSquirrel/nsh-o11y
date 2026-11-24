/**
 * A heatmap of a distribution over time: latencies, sizes, anything with many observations a second.
 * Each column is `step` ms; each row a bucket of values (log-spaced by default, as latency wants); each
 * cell's color the count of observations in it. Percentile lines are read from the buckets. The store,
 * engine and renderer are plain TypeScript, as the time series chart's are.
 */
import { drawTooltip, r1, RectBatch, type TooltipLine } from "./draw";
import { fontOf, measureCached, type Ctx2D, type PathFactory } from "./render";
import { formatTimeFull, formatValue, timeTicks, type Tick, type TimeZone, type Unit } from "./scale";
import type { ChartTheme } from "./types";

export interface HeatmapOptions {
  /** Column width in ms. Default 1000. */
  step?: number;
  /** The value range the buckets cover; values outside go to the first or last bucket. Default 1 to 10,000. */
  min?: number;
  max?: number;
  /** "log" (the default: equal ratios per bucket, as latencies spread) or "linear". */
  scale?: "log" | "linear";
  /** How many buckets. Default 40. */
  buckets?: number;
  /** Keep at most this many columns, dropping the oldest. Default unlimited. */
  maxColumns?: number;
}

/** One observation kept with what it came from: a trace id, so a cell leads to a request in it. */
export interface Exemplar {
  time: number;
  value: number;
  /** A trace id, usually. */
  id: string;
  /** Drawn red. */
  error?: boolean;
  attributes?: Record<string, string | number | boolean>;
}

export interface HeatmapColumn {
  time: number;
  counts: Float64Array;
  total: number;
  /** At most one exemplar per bucket: the newest. */
  exemplars?: (Exemplar | undefined)[];
}

export class HeatmapStore {
  readonly step: number;
  readonly min: number;
  readonly max: number;
  readonly scale: "log" | "linear";
  readonly buckets: number;
  readonly maxColumns: number;
  /** Bucket edges: bucket i holds [edges[i], edges[i + 1]). */
  readonly edges: Float64Array;
  private cols: HeatmapColumn[] = [];
  private listeners = new Set<() => void>();
  version = 0;

  constructor(o: HeatmapOptions = {}) {
    this.step = o.step ?? 1000;
    this.scale = o.scale ?? "log";
    this.min = o.min ?? (this.scale === "log" ? 1 : 0);
    this.max = o.max ?? 10_000;
    this.buckets = Math.max(1, Math.round(o.buckets ?? 40));
    this.maxColumns = o.maxColumns ?? Infinity;
    this.edges = new Float64Array(this.buckets + 1);
    for (let i = 0; i <= this.buckets; i++) this.edges[i] = this.valueAt(i / this.buckets);
  }

  /** The value at a fraction (0 to 1) of the range, in the store's scale. */
  valueAt(f: number) {
    return this.scale === "log" ? this.min * Math.pow(this.max / this.min, f) : this.min + (this.max - this.min) * f;
  }

  /** Where a value sits in the range, 0 to 1 (clamped). */
  fractionOf(v: number) {
    const f = this.scale === "log" ? Math.log(Math.max(v, this.min) / this.min) / Math.log(this.max / this.min) : (v - this.min) / (this.max - this.min);
    return Math.max(0, Math.min(1, f));
  }

  bucketOf(v: number) {
    return Math.min(this.buckets - 1, Math.floor(this.fractionOf(v) * this.buckets));
  }

  length() {
    return this.cols.length;
  }

  column(i: number): HeatmapColumn {
    return this.cols[i];
  }

  extent(): [number, number] | null {
    const n = this.cols.length;
    return n ? [this.cols[0].time, this.cols[n - 1].time + this.step] : null;
  }

  /** The column for time t, made when missing (columns stay in time order). */
  private col(t: number): HeatmapColumn {
    const time = Math.floor(t / this.step) * this.step;
    const n = this.cols.length;
    if (n && this.cols[n - 1].time === time) return this.cols[n - 1];
    let i = n;
    if (n && this.cols[n - 1].time > time) {
      i = this.lower(time);
      if (i < n && this.cols[i].time === time) return this.cols[i];
    }
    const c = { time, counts: new Float64Array(this.buckets), total: 0 };
    this.cols.splice(i, 0, c);
    return c;
  }

  /** The first column at or after t. */
  lower(t: number) {
    let lo = 0;
    let hi = this.cols.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.cols[m].time < t) lo = m + 1;
      else hi = m;
    }
    return lo;
  }

  /** Adds observations at time t: one value or many. */
  add(t: number, values: number | ArrayLike<number>) {
    const c = this.col(t);
    if (typeof values === "number") {
      if (values === values) {
        c.counts[this.bucketOf(values)]++;
        c.total++;
      }
    } else {
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v !== v) continue;
        c.counts[this.bucketOf(v)]++;
        c.total++;
      }
    }
    this.changed();
  }

  /**
   * Keeps an exemplar (and counts it as an observation when `count`): one per cell, the newest replacing
   * the one before.
   */
  addExemplar(ex: Exemplar, count = false) {
    const c = this.col(ex.time);
    const b = this.bucketOf(ex.value);
    (c.exemplars ??= [])[b] = ex;
    if (count) {
      c.counts[b]++;
      c.total++;
    }
    this.changed();
  }

  /** The exemplars of columns [i0, i1). */
  exemplars(i0 = 0, i1 = this.cols.length): Exemplar[] {
    const out: Exemplar[] = [];
    for (let i = Math.max(0, i0); i < Math.min(i1, this.cols.length); i++) {
      const ex = this.cols[i].exemplars;
      if (ex) for (const e of ex) if (e) out.push(e);
    }
    return out;
  }

  /** Adds pre-bucketed counts at time t, one per bucket of this store (a histogram metric's deltas). */
  addCounts(t: number, counts: ArrayLike<number>) {
    const c = this.col(t);
    for (let i = 0; i < Math.min(this.buckets, counts.length); i++) {
      c.counts[i] += counts[i];
      c.total += counts[i];
    }
    this.changed();
  }

  clear() {
    this.cols = [];
    this.changed();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    if (this.cols.length > this.maxColumns * 1.1 || (this.maxColumns < 50 && this.cols.length > this.maxColumns)) this.cols.splice(0, this.cols.length - this.maxColumns);
    this.version++;
    for (const fn of this.listeners) fn();
  }

  /** The q-quantile (0 to 1) of column i, interpolated inside its bucket in the store's scale; NaN when empty. */
  quantile(i: number, q: number): number {
    const c = this.cols[i];
    if (!c || c.total <= 0) return NaN;
    const want = q * c.total;
    let acc = 0;
    for (let b = 0; b < this.buckets; b++) {
      const n = c.counts[b];
      if (acc + n >= want && n > 0) {
        const f = (want - acc) / n;
        return this.valueAt((b + f) / this.buckets);
      }
      acc += n;
    }
    return this.edges[this.buckets];
  }
}

const RAMP_STEPS = 16;

function hex(n: number) {
  return Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
}

function mix(a: string, b: string, t: number) {
  const p = (s: string, i: number) => parseInt(s.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${hex(p(a, 0) + (p(b, 0) - p(a, 0)) * t)}${hex(p(a, 1) + (p(b, 1) - p(a, 1)) * t)}${hex(p(a, 2) + (p(b, 2) - p(a, 2)) * t)}`;
}

/** A sequential ramp, faint to strong, through three stops: on light surfaces dark is more, on dark light is. */
export function heatRamp(dark: boolean, stops?: [string, string, string]): string[] {
  const [a, b, c] = stops ?? (dark ? ["#16263d", "#2a78d6", "#bfe0ff"] : ["#e6f0fb", "#3987e5", "#0d2a57"]);
  return Array.from({ length: RAMP_STEPS }, (_, i) => {
    const t = i / (RAMP_STEPS - 1);
    return t < 0.5 ? mix(a, b, t * 2) : mix(b, c, (t - 0.5) * 2);
  });
}

export const PERCENTILE_COLORS = ["#eda100", "#e34948", "#e87ba4"];

export class HeatmapEngine {
  width = 0;
  height = 0;
  store: HeatmapStore | null = null;
  x0 = 0;
  x1 = 1;
  plot = { left: 0, top: 4, width: 1, height: 1 };
  xTicks: Tick[] = [];
  yTicks: number[] = [];
  unit: Unit = "ms";
  timeZone: TimeZone = "local";
  fontSize = 11;
  percentiles: number[] = [0.5, 0.99];
  ramp: string[] = heatRamp(false);
  /** Columns in view: [first, end). */
  i0 = 0;
  i1 = 0;
  maxCount = 0;
  /** The cell under the pointer. */
  hover: { col: number; bucket: number } | null = null;
  pointer = { x: 0, y: 0 };
  /** Another chart's cursor time (a linked crosshair), or null. */
  syncTime: number | null = null;
  /** Draw the store's exemplars. */
  showExemplars = true;
  /** The exemplar under the pointer. */
  hoverExemplar: Exemplar | null = null;

  /** The exemplars drawn: those in view, thinned so none overlap. */
  shown: Exemplar[] = [];
  /** How far apart drawn exemplars stay, in points. */
  exemplarSpacing = 12;

  /**
   * Errors first, then the slowest: each exemplar is kept unless one kept already sits within
   * `exemplarSpacing` of it (checked in a grid of that size), so a busy minute shows a few, not hundreds.
   */
  private thin(s: HeatmapStore): Exemplar[] {
    if (!this.showExemplars) return [];
    const all = s.exemplars(this.i0, this.i1).filter((ex) => ex.time >= this.x0 && ex.time <= this.x1);
    all.sort((a, b) => (a.error === b.error ? b.value - a.value : a.error ? -1 : 1));
    const g = this.exemplarSpacing;
    const grid = new Map<string, { x: number; y: number }[]>();
    const kept: Exemplar[] = [];
    for (const ex of all) {
      const { x, y } = this.exemplarPoint(ex);
      const gx = Math.floor(x / g);
      const gy = Math.floor(y / g);
      let clear = true;
      for (let i = -1; i <= 1 && clear; i++)
        for (let j = -1; j <= 1 && clear; j++)
          for (const p of grid.get(`${gx + i},${gy + j}`) ?? []) if ((p.x - x) * (p.x - x) + (p.y - y) * (p.y - y) < g * g) clear = false;
      if (!clear) continue;
      kept.push(ex);
      const key = `${gx},${gy}`;
      const list = grid.get(key);
      if (list) list.push({ x, y });
      else grid.set(key, [{ x, y }]);
    }
    return kept;
  }

  /** Where an exemplar is drawn: its time and value. */
  exemplarPoint(ex: Exemplar) {
    return { x: this.toPx(ex.time), y: this.toPy(ex.value) };
  }

  /** The exemplar within `radius` points of (x, y), the nearest. */
  exemplarAt(x: number, y: number, radius = 7): Exemplar | null {
    const s = this.store;
    if (!s || !this.showExemplars) return null;
    let best: Exemplar | null = null;
    let bestD = radius * radius;
    for (const ex of this.shown) {
      const p = this.exemplarPoint(ex);
      const d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
      if (d <= bestD) {
        bestD = d;
        best = ex;
      }
    }
    return best;
  }

  exemplarLines(ex: Exemplar): TooltipLine[] {
    const lines: TooltipLine[] = [
      { text: `${formatValue(ex.value, this.unit)} · ${formatTimeFull(ex.time, 1, this.timeZone)}`, color: ex.error ? "#e34948" : undefined },
      { text: `trace ${ex.id.slice(0, 16)}`, muted: true },
    ];
    for (const k in ex.attributes ?? {}) lines.push({ text: `${k} ${String(ex.attributes![k])}`, muted: true });
    lines.push({ text: "Press to open", muted: true });
    return lines;
  }
  measure: (t: string) => number = (t) => t.length * 6;

  setSize(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  update(x0: number, x1: number) {
    const s = this.store;
    this.x0 = x0;
    this.x1 = x1 > x0 ? x1 : x0 + 1;
    this.yTicks = s ? this.valueTicks(s) : [];
    let wy = 0;
    for (const v of this.yTicks) wy = Math.max(wy, this.measure(formatValue(v, this.unit)));
    const left = Math.round(wy + 10);
    this.plot = { left, top: 4, width: Math.max(1, this.width - left - 4), height: Math.max(1, this.height - 4 - Math.round(this.fontSize * 1.9)) };
    this.xTicks = timeTicks(this.x0, this.x1, this.plot.width, 90, this.timeZone).ticks;
    if (!s) return;
    this.i0 = s.lower(this.x0 - s.step);
    this.i1 = s.lower(this.x1);
    let max = 0;
    for (let i = this.i0; i < this.i1; i++) {
      const c = s.column(i).counts;
      for (let b = 0; b < c.length; b++) if (c[b] > max) max = c[b];
    }
    this.maxCount = max;
    this.shown = this.thin(s);
  }

  /** Ticks at 1-2-5 values (log) or even steps (linear), about 28 points apart. */
  private valueTicks(s: HeatmapStore): number[] {
    const h = Math.max(1, this.height - 30);
    const want = Math.max(2, Math.floor(h / 28));
    if (s.scale === "linear") {
      const raw = (s.max - s.min) / want;
      const p = Math.pow(10, Math.floor(Math.log10(raw)));
      const step = [1, 2, 5, 10].map((m) => m * p).find((v) => v >= raw) ?? raw;
      const out: number[] = [];
      for (let v = Math.ceil(s.min / step) * step; v <= s.max + 1e-9; v += step) out.push(v);
      return out;
    }
    const all: number[] = [];
    for (let e = Math.floor(Math.log10(s.min)); e <= Math.ceil(Math.log10(s.max)); e++) for (const m of [1, 2, 5]) {
      const v = m * Math.pow(10, e);
      if (v >= s.min * 0.999 && v <= s.max * 1.001) all.push(v);
    }
    if (all.length <= want) return all;
    const decades = all.filter((v) => Math.abs(Math.log10(v) - Math.round(Math.log10(v))) < 1e-9);
    return decades.length >= 2 ? decades : all.filter((_, i) => i % Math.ceil(all.length / want) === 0);
  }

  toPx(t: number) {
    return this.plot.left + ((t - this.x0) / (this.x1 - this.x0)) * this.plot.width;
  }

  fromPx(px: number) {
    return this.x0 + ((px - this.plot.left) / this.plot.width) * (this.x1 - this.x0);
  }

  /** y of a value. */
  toPy(v: number) {
    const s = this.store;
    return this.plot.top + this.plot.height - (s ? s.fractionOf(v) : 0) * this.plot.height;
  }

  inPlot(x: number, y: number) {
    const p = this.plot;
    return x >= p.left && x <= p.left + p.width && y >= p.top && y <= p.top + p.height;
  }

  /** The cell at (x, y), or null. */
  cellAt(x: number, y: number): { col: number; bucket: number } | null {
    const s = this.store;
    if (!s || !this.inPlot(x, y)) return null;
    const t = this.fromPx(x);
    const i = s.lower(Math.floor(t / s.step) * s.step);
    if (i >= s.length() || s.column(i).time > t) return null;
    const f = (this.plot.top + this.plot.height - y) / this.plot.height;
    return { col: i, bucket: Math.max(0, Math.min(s.buckets - 1, Math.floor(f * s.buckets))) };
  }

  colorOf(count: number) {
    if (count <= 0 || this.maxCount <= 0) return null;
    const t = Math.log1p(count) / Math.log1p(this.maxCount);
    return this.ramp[Math.max(0, Math.min(this.ramp.length - 1, Math.round(t * (this.ramp.length - 1))))];
  }

  cellLines(h: { col: number; bucket: number }): TooltipLine[] {
    const s = this.store;
    if (!s) return [];
    const c = s.column(h.col);
    const n = c.counts[h.bucket];
    const lo = s.edges[h.bucket];
    const hi = s.edges[h.bucket + 1];
    const lines: TooltipLine[] = [
      { text: `${formatTimeFull(c.time, s.step, this.timeZone)} · ${c.total.toLocaleString()} observations`, muted: true },
      { text: `${formatValue(lo, this.unit)} – ${formatValue(hi, this.unit)}: ${n.toLocaleString()} (${c.total ? ((n / c.total) * 100).toFixed(1) : "0"}%)`, color: this.colorOf(n) ?? undefined },
    ];
    this.percentiles.forEach((q, k) => {
      const v = s.quantile(h.col, q);
      lines.push({ text: `p${+(q * 100).toFixed(1)} ${formatValue(v, this.unit)}`, color: PERCENTILE_COLORS[k % PERCENTILE_COLORS.length] });
    });
    return lines;
  }
}

/** The cells, the percentile lines and the axes. */
export function renderHeatmap(cx: Ctx2D, e: HeatmapEngine, theme: ChartTheme, path: PathFactory) {
  const s = e.store;
  const { plot } = e;
  const font = fontOf(theme);
  const bottom = plot.top + plot.height;
  if (theme.background) {
    cx.fillStyle = theme.background;
    cx.fillRect(0, 0, e.width, e.height);
  }
  cx.save();
  cx.beginPath();
  cx.rect(plot.left, plot.top, plot.width, plot.height);
  cx.clip();
  if (s) {
    const cells = new RectBatch();
    const cw = (s.step / (e.x1 - e.x0)) * plot.width;
    const ch = plot.height / s.buckets;
    for (let i = e.i0; i < e.i1; i++) {
      const c = s.column(i);
      const x = e.toPx(c.time);
      for (let b = 0; b < s.buckets; b++) {
        const color = e.colorOf(c.counts[b]);
        if (!color) continue;
        cells.add(color, x, bottom - (b + 1) * ch, Math.max(0.6, cw + 0.25), ch + 0.25);
      }
    }
    cells.fill(cx, path);
    // Exemplars: small diamonds on the surface color, ringed in the text color (errors in red).
    if (e.showExemplars) {
      let ok = "";
      let bad = "";
      for (const ex of e.shown) {
        const { x, y } = e.exemplarPoint(ex);
        const d = `M${r1(x)} ${r1(y - 4.5)}L${r1(x + 4.5)} ${r1(y)}L${r1(x)} ${r1(y + 4.5)}L${r1(x - 4.5)} ${r1(y)}Z`;
        if (ex.error) bad += d;
        else ok += d;
      }
      for (const [d, color] of [[ok, theme.text], [bad, "#e34948"]] as const) {
        if (!d) continue;
        const p = path(d);
        cx.fillStyle = theme.surface;
        cx.fill(p);
        cx.strokeStyle = color;
        cx.lineWidth = 1.25;
        cx.stroke(p);
      }
    }
    // Percentile lines across the columns' middles; gaps where a column is empty.
    e.percentiles.forEach((q, k) => {
      let d = "";
      let pen = false;
      for (let i = e.i0; i < e.i1; i++) {
        const v = s.quantile(i, q);
        if (v !== v) {
          pen = false;
          continue;
        }
        const x = e.toPx(s.column(i).time + s.step / 2);
        d += `${pen ? "L" : "M"}${r1(x)} ${r1(e.toPy(v))}`;
        pen = true;
      }
      if (!d) return;
      cx.strokeStyle = PERCENTILE_COLORS[k % PERCENTILE_COLORS.length];
      cx.lineWidth = 1.5;
      cx.lineJoin = "round";
      cx.stroke(path(d));
    });
  }
  cx.restore();
  cx.font = font;
  cx.fillStyle = theme.muted;
  cx.textAlign = "right";
  cx.textBaseline = "middle";
  for (const v of e.yTicks) cx.fillText(formatValue(v, e.unit), plot.left - 6, r1(e.toPy(v)));
  cx.textAlign = "center";
  cx.textBaseline = "top";
  let lastRight = -Infinity;
  for (const t of e.xTicks) {
    const w = measureCached(cx, font, t.label);
    const x = Math.max(w / 2 + 1, Math.min(e.width - w / 2 - 1, e.toPx(t.value)));
    if (x - w / 2 < lastRight + 8) continue;
    cx.fillText(t.label, r1(x), bottom + Math.round(theme.fontSize * 0.5));
    lastRight = x + w / 2;
  }
}

/** The hovered cell, a linked chart's crosshair, and the tooltip. */
export function renderHeatmapOverlay(cx: Ctx2D, e: HeatmapEngine, theme: ChartTheme) {
  const s = e.store;
  const { plot } = e;
  if (!s) return;
  const line = (x: number) => {
    if (x < plot.left || x > plot.left + plot.width) return;
    cx.strokeStyle = theme.cursor;
    cx.lineWidth = 1;
    cx.setLineDash([3, 3]);
    cx.beginPath();
    cx.moveTo(Math.round(x) + 0.5, plot.top);
    cx.lineTo(Math.round(x) + 0.5, plot.top + plot.height);
    cx.stroke();
    cx.setLineDash([]);
  };
  const hx = e.hoverExemplar;
  if (hx) {
    const { x, y } = e.exemplarPoint(hx);
    cx.strokeStyle = hx.error ? "#e34948" : theme.text;
    cx.lineWidth = 2;
    cx.beginPath();
    cx.moveTo(r1(x), r1(y - 7));
    cx.lineTo(r1(x + 7), r1(y));
    cx.lineTo(r1(x), r1(y + 7));
    cx.lineTo(r1(x - 7), r1(y));
    cx.closePath();
    cx.stroke();
    drawTooltip(cx, theme, e.exemplarLines(hx), e.pointer.x, e.pointer.y, e.width, e.height);
    return;
  }
  const h = e.hover;
  if (h) {
    const c = s.column(h.col);
    const x = e.toPx(c.time);
    const cw = Math.max(2, (s.step / (e.x1 - e.x0)) * plot.width);
    const ch = plot.height / s.buckets;
    cx.strokeStyle = theme.text;
    cx.lineWidth = 1.5;
    cx.beginPath();
    cx.rect(r1(x), r1(plot.top + plot.height - (h.bucket + 1) * ch), r1(cw), r1(ch));
    cx.stroke();
    drawTooltip(cx, theme, e.cellLines(h), e.pointer.x, e.pointer.y, e.width, e.height);
  } else if (e.syncTime !== null) line(e.toPx(e.syncTime));
}
