/**
 * The log-volume histogram: stacked bars of lines per level over time, its axes, the bucket under the
 * pointer and a drag-to-select box. Plain TypeScript (the engine and its renderer), as `ChartEngine` is.
 */
import { drawTooltip, r1, RectBatch, type TooltipLine } from "./draw";
import { LOG_LEVEL_COLORS, type LogFilter, type LogHistogram, type LogLevel, type LogStore } from "./logs";
import { fontOf, measureCached, type Ctx2D, type PathFactory } from "./render";
import { formatTimeFull, formatValue, timeStep, timeTicks, valueTicks, type Tick, type TimeZone } from "./scale";
import type { ChartTheme } from "./types";

/** Bars are stacked most severe at the bottom, where the eye finds them. */
const STACK: readonly LogLevel[] = ["fatal", "error", "warn", "info", "debug", "trace"];

export class LogVolumeEngine {
  width = 0;
  height = 0;
  x0 = 0;
  x1 = 1;
  yMax = 1;
  plot = { left: 0, top: 4, width: 0, height: 0 };
  hist: LogHistogram | null = null;
  xTicks: Tick[] = [];
  yTicks: number[] = [];
  timeZone: TimeZone = "local";
  fontSize = 11;
  colors: Record<LogLevel, string> = { ...LOG_LEVEL_COLORS };
  /** The bucket under the pointer, or -1. */
  hover = -1;
  hoverY = 0;
  /** A drag in progress, in points. */
  selection: { from: number; to: number } | null = null;
  /** The range the list is narrowed to, drawn shaded. */
  range: [number, number] | null = null;
  measure: (text: string) => number = (t) => t.length * 6;

  setSize(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  /** Buckets the store's lines over [x0, x1] for about one bar every 6 points. */
  update(store: LogStore, filter: LogFilter, x0: number, x1: number) {
    if (!(x1 > x0)) {
      x0 -= 30_000;
      x1 += 30_000;
    }
    this.x0 = x0;
    this.x1 = x1;
    const yLabel = this.measure("0000") + 8;
    this.plot = {
      left: Math.round(yLabel),
      top: 4,
      width: Math.max(1, this.width - Math.round(yLabel) - 4),
      height: Math.max(1, this.height - 4 - Math.round(this.fontSize * 1.9)),
    };
    const step = timeStep((x1 - x0) / Math.max(1, this.plot.width / 6));
    this.hist = store.histogram(x0, x1, step, { levels: filter.levels, text: filter.text });
    const top = Math.max(1, this.hist.max);
    this.yTicks = valueTicks(0, top, this.plot.height, 22).filter((v) => v === Math.round(v));
    this.yMax = Math.max(top, this.yTicks.length ? this.yTicks[this.yTicks.length - 1] : top);
    this.xTicks = timeTicks(x0, x1, this.plot.width, 90, this.timeZone).ticks;
  }

  toPx(t: number) {
    return this.plot.left + ((t - this.x0) / (this.x1 - this.x0)) * this.plot.width;
  }

  fromPx(px: number) {
    return this.x0 + ((px - this.plot.left) / this.plot.width) * (this.x1 - this.x0);
  }

  toPy(v: number) {
    return this.plot.top + this.plot.height - (v / this.yMax) * this.plot.height;
  }

  inPlot(x: number, y: number) {
    const p = this.plot;
    return x >= p.left && x <= p.left + p.width && y >= p.top && y <= p.top + p.height;
  }

  /** The bucket at x points, or -1. */
  bucketAt(x: number) {
    const h = this.hist;
    if (!h || x < this.plot.left || x > this.plot.left + this.plot.width) return -1;
    const k = Math.floor((this.fromPx(x) - h.t0) / h.step);
    return k >= 0 && k < h.buckets ? k : -1;
  }

  /** The range a finished drag selected, or null for a click. */
  endSelection(): [number, number] | null {
    const s = this.selection;
    this.selection = null;
    if (!s || Math.abs(s.to - s.from) < 4) return null;
    const a = this.fromPx(Math.max(this.plot.left, Math.min(s.from, s.to)));
    const b = this.fromPx(Math.min(this.plot.left + this.plot.width, Math.max(s.from, s.to)));
    return b > a ? [a, b] : null;
  }

  /** What the tooltip says for bucket k: its time and total, then each level's count (two lines: the panel is short). */
  bucketLines(k: number): TooltipLine[] {
    const h = this.hist;
    if (!h || k < 0) return [];
    const t = h.t0 + k * h.step;
    let total = 0;
    const parts: string[] = [];
    for (const l of [...STACK].reverse()) {
      const c = h.counts[l][k];
      total += c;
      if (c > 0) parts.push(`${l} ${c.toLocaleString()}`);
    }
    return [
      { text: `${formatTimeFull(t, h.step, this.timeZone)} · ${total.toLocaleString()} line${total === 1 ? "" : "s"}` },
      { text: parts.length ? parts.join(" · ") : "none", muted: true },
    ];
  }
}

/** The bars, the grid and the axes. */
export function renderLogVolume(cx: Ctx2D, e: LogVolumeEngine, theme: ChartTheme, path: PathFactory) {
  const { plot } = e;
  const font = fontOf(theme);
  const bottom = plot.top + plot.height;
  if (theme.background) {
    cx.fillStyle = theme.background;
    cx.fillRect(0, 0, e.width, e.height);
  }
  let grid = "";
  for (const v of e.yTicks) {
    const y = Math.round(e.toPy(v)) + 0.5;
    grid += `M${plot.left} ${y}H${plot.left + plot.width}`;
  }
  if (grid) {
    cx.strokeStyle = theme.grid;
    cx.lineWidth = 1;
    cx.stroke(path(grid));
  }
  if (e.range) {
    const a = Math.max(plot.left, e.toPx(e.range[0]));
    const b = Math.min(plot.left + plot.width, e.toPx(e.range[1]));
    if (b > a) {
      cx.globalAlpha = 0.1;
      cx.fillStyle = theme.selection;
      cx.fillRect(r1(a), plot.top, r1(b - a), plot.height);
      cx.globalAlpha = 1;
    }
  }
  const h = e.hist;
  if (h) {
    const bars = new RectBatch();
    const bw = (h.step / (e.x1 - e.x0)) * plot.width;
    const gap = bw > 4 ? 1 : 0;
    for (let k = 0; k < h.buckets; k++) {
      const x = e.toPx(h.t0 + k * h.step);
      const l = Math.max(plot.left, x);
      const rr = Math.min(plot.left + plot.width, x + bw - gap);
      if (rr <= l) continue;
      let acc = 0;
      for (const lv of STACK) {
        const c = h.counts[lv][k];
        if (!c) continue;
        const y0 = e.toPy(acc);
        acc += c;
        const y1 = e.toPy(acc);
        bars.add(e.colors[lv], l, y1, rr - l, Math.max(1, y0 - y1));
      }
    }
    bars.fill(cx, path, 0.85);
  }
  cx.font = font;
  cx.fillStyle = theme.muted;
  cx.textAlign = "right";
  cx.textBaseline = "middle";
  for (const v of e.yTicks) {
    if (v === 0) continue;
    cx.fillText(formatValue(v, "short"), plot.left - 6, r1(e.toPy(v)));
  }
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

/** The hovered bucket, the drag box and the tooltip. */
export function renderLogVolumeOverlay(cx: Ctx2D, e: LogVolumeEngine, theme: ChartTheme) {
  const { plot } = e;
  const s = e.selection;
  if (s) {
    const a = Math.max(plot.left, Math.min(s.from, s.to));
    const b = Math.min(plot.left + plot.width, Math.max(s.from, s.to));
    cx.globalAlpha = 0.16;
    cx.fillStyle = theme.selection;
    cx.fillRect(r1(a), plot.top, r1(b - a), plot.height);
    cx.globalAlpha = 1;
  }
  const h = e.hist;
  if (!h || e.hover < 0) return;
  const x = e.toPx(h.t0 + e.hover * h.step);
  const bw = (h.step / (e.x1 - e.x0)) * plot.width;
  const l = Math.max(plot.left, x);
  const rr = Math.min(plot.left + plot.width, x + bw);
  cx.globalAlpha = 0.1;
  cx.fillStyle = theme.text;
  cx.fillRect(r1(l), plot.top, r1(Math.max(1, rr - l)), plot.height);
  cx.globalAlpha = 1;
  if (!s) drawTooltip(cx, theme, e.bucketLines(e.hover), (l + rr) / 2, e.hoverY, e.width, e.height);
}
