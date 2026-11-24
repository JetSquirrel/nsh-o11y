/**
 * Draws a `ChartEngine` with a Canvas 2D context, in two layers:
 *
 * - `renderPlot`: the grid, axes, annotations, thresholds and series. It only changes when the data, the
 *   viewport, the size or the theme do.
 * - `renderOverlay`: the crosshair, the dots at the cursor and the drag-to-zoom box. It changes with every
 *   pointer move, and costs a few calls, so moving the pointer never draws the data again.
 *
 * Series are traced by the store (TypeScript or Rust) as SVG path data and drawn with one `Path2D` each,
 * so a series costs one or two canvas calls whatever its size.
 */
import type { ChartEngine } from "./chart";
import type { ChartTheme } from "./types";

/** The part of `CanvasRenderingContext2D` the renderer uses (NSH's `<Canvas>` and `OffscreenCanvas` give it). */
export interface Ctx2D {
  save(): void;
  restore(): void;
  scale(x: number, y: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void;
  closePath(): void;
  clip(path?: any): void;
  fill(path?: any): void;
  stroke(path?: any): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  roundRect?(x: number, y: number, w: number, h: number, r: number): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  measureText(text: string): { width: number };
  setLineDash(segments: number[]): void;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: unknown;
  lineCap: "butt" | "round" | "square";
  lineJoin: "miter" | "round" | "bevel";
  globalAlpha: unknown;
  font: string;
  textAlign: "start" | "end" | "left" | "right" | "center";
  textBaseline: "alphabetic" | "top" | "hanging" | "middle" | "ideographic" | "bottom";
}

/** Makes a path object from SVG path data: `(d) => new Path2D(d)` on NSH. */
export type PathFactory = (d: string) => unknown;

const widthCache = new Map<string, number>();

/** Text widths are measured once per font and text: axis labels repeat frame after frame. */
export function measureCached(cx: Pick<Ctx2D, "measureText">, font: string, text: string): number {
  const key = font + "\u0000" + text;
  let w = widthCache.get(key);
  if (w === undefined) {
    if (widthCache.size > 2000) widthCache.clear();
    w = cx.measureText(text).width;
    widthCache.set(key, w);
  }
  return w;
}

export function fontOf(theme: ChartTheme) {
  return `${theme.fontSize}px ${theme.fontFamily}`;
}

function r(v: number) {
  return Math.round(v * 10) / 10;
}

/** Crisp 1-point lines: on the middle of a pixel row. */
function crisp(v: number) {
  return Math.round(v) + 0.5;
}

/** Traced coordinates are integers in 1/TRACE_SCALE points. */
const TRACE_SCALE = 10;

/** The per-frame cost of the last `renderPlot`, for perf readouts. */
export const renderStats = { traceMs: 0, points: 0, samples: 0 };

/** Draws the plot layer. Call `engine.update()` first. */
export function renderPlot(cx: Ctx2D, engine: ChartEngine, theme: ChartTheme, path: PathFactory) {
  const { plot } = engine;
  const font = fontOf(theme);
  const right = plot.left + plot.width;
  const bottom = plot.top + plot.height;
  const o = engine.options;

  if (theme.background) {
    cx.fillStyle = theme.background;
    cx.fillRect(0, 0, engine.width, engine.height);
  }

  // Grid: one path for every line.
  let grid = "";
  for (const v of engine.yTicks) {
    const y = crisp(engine.toPy(v));
    if (y < plot.top - 1 || y > bottom + 1) continue;
    grid += `M${plot.left} ${y}H${right}`;
  }
  for (const t of engine.xTicks) {
    const x = crisp(engine.toPx(t.value));
    grid += `M${x} ${plot.top}V${bottom}`;
  }
  if (grid) {
    cx.strokeStyle = theme.grid;
    cx.lineWidth = 1;
    cx.stroke(path(grid));
  }

  // Annotations behind the data: spans shaded, moments as lines.
  for (const a of o.annotations) {
    if ((a.end ?? a.time) < engine.x0 || a.time > engine.x1) continue;
    const color = a.color ?? theme.muted;
    const x = engine.toPx(a.time);
    if (a.end !== undefined && a.end > a.time) {
      const x2 = engine.toPx(a.end);
      const l = Math.max(plot.left, x);
      cx.globalAlpha = 0.1;
      cx.fillStyle = color;
      cx.fillRect(l, plot.top, Math.min(right, x2) - l, plot.height);
      cx.globalAlpha = 1;
    }
    if (x >= plot.left && x <= right) {
      cx.strokeStyle = color;
      cx.lineWidth = 1;
      cx.setLineDash([2, 3]);
      cx.beginPath();
      cx.moveTo(crisp(x), plot.top);
      cx.lineTo(crisp(x), bottom);
      cx.stroke();
      cx.setLineDash([]);
    }
  }

  // Series, clipped to the plot.
  cx.save();
  cx.beginPath();
  cx.rect(plot.left, plot.top, plot.width, plot.height);
  cx.clip();
  const st = engine.store;
  let points = 0;
  let samples = 0;
  const t0 = Date.now();
  if (st) {
    const base = {
      x0: engine.x0,
      x1: engine.x1,
      y0: engine.y0,
      y1: engine.y1,
      left: plot.left,
      top: plot.top,
      width: plot.width,
      height: plot.height,
      density: 1,
      scale: TRACE_SCALE,
    };
    // Paths come in tenths of a point (integers are quicker to write and parse): draw them scaled down.
    cx.scale(1 / TRACE_SCALE, 1 / TRACE_SCALE);
    cx.lineJoin = "round";
    cx.lineCap = "butt";
    for (const s of engine.series) {
      if (!s.show || s.index >= st.seriesCount) continue;
      if (s.fill > 0) {
        const zero = engine.y0 <= 0 && engine.y1 >= 0 ? engine.toPy(0) : bottom;
        const d = st.trace(s.index, { ...base, baseline: zero, spanGaps: s.spanGaps, step: s.step });
        if (d) {
          cx.globalAlpha = s.fill;
          cx.fillStyle = s.color;
          cx.fill(path(d));
          cx.globalAlpha = 1;
        }
      }
      const d = st.trace(s.index, { ...base, spanGaps: s.spanGaps, step: s.step });
      if (!d) continue;
      const stats = (st as { stats?: { points: number; samples: number } }).stats;
      if (stats) {
        points += stats.points;
        samples += stats.samples;
      }
      cx.strokeStyle = s.color;
      cx.lineWidth = s.width * TRACE_SCALE;
      if (s.dash) cx.setLineDash(s.dash.map((v) => v * TRACE_SCALE));
      cx.stroke(path(d));
      if (s.dash) cx.setLineDash([]);
    }
  }
  if (st) cx.scale(TRACE_SCALE, TRACE_SCALE);
  renderStats.traceMs = Date.now() - t0;
  renderStats.points = points;
  renderStats.samples = samples;

  // Thresholds over the data.
  for (const t of o.thresholds) {
    if (t.value < engine.y0 || t.value > engine.y1) continue;
    const y = crisp(engine.toPy(t.value));
    cx.strokeStyle = t.color ?? theme.muted;
    cx.lineWidth = 1;
    cx.setLineDash(t.dash ?? [4, 4]);
    cx.beginPath();
    cx.moveTo(plot.left, y);
    cx.lineTo(right, y);
    cx.stroke();
    cx.setLineDash([]);
  }
  cx.restore();

  // Labels.
  cx.font = font;
  cx.fillStyle = theme.muted;
  cx.textAlign = "right";
  cx.textBaseline = "middle";
  for (const v of engine.yTicks) {
    const y = engine.toPy(v);
    if (y < plot.top - 1 || y > bottom + 1) continue;
    cx.fillText(engine.formatY(v), plot.left - 6, r(y));
  }
  cx.textAlign = "center";
  cx.textBaseline = "top";
  let lastRight = -Infinity;
  const labelY = bottom + Math.round(theme.fontSize * 0.5);
  for (const t of engine.xTicks) {
    const x = engine.toPx(t.value);
    const w = measureCached(cx, font, t.label);
    // Keep labels inside the canvas and apart from each other.
    const cxs = Math.max(w / 2 + 1, Math.min(engine.width - w / 2 - 1, x));
    if (cxs - w / 2 < lastRight + 8) continue;
    cx.fillText(t.label, r(cxs), labelY);
    lastRight = cxs + w / 2;
  }

  // Threshold and annotation labels, in their colors, on a backing of the surface so they read over lines.
  const fs = theme.fontSize;
  const backing = (x: number, y: number, w: number) => {
    cx.globalAlpha = 0.85;
    cx.fillStyle = theme.surface;
    cx.fillRect(r(x - 2), r(y - 1), r(w + 4), fs + 3);
    cx.globalAlpha = 1;
  };
  cx.textBaseline = "top";
  cx.textAlign = "left";
  for (const t of o.thresholds) {
    if (!t.label || t.value < engine.y0 || t.value > engine.y1) continue;
    const w = measureCached(cx, font, t.label);
    const x = right - 4 - w;
    const y = engine.toPy(t.value) - fs - 3;
    backing(x, y, w);
    cx.fillStyle = t.color ?? theme.muted;
    cx.fillText(t.label, r(x), r(y));
  }
  for (const a of o.annotations) {
    if (!a.label || a.time < engine.x0 || a.time > engine.x1) continue;
    const w = measureCached(cx, font, a.label);
    const x = engine.toPx(a.time) + 4;
    backing(x, plot.top + 2, w);
    cx.fillStyle = a.color ?? theme.muted;
    cx.fillText(a.label, r(x), plot.top + 2);
  }
}

/** Draws the overlay layer: the drag-to-zoom box, the crosshair and the dots at the cursor. */
export function renderOverlay(cx: Ctx2D, engine: ChartEngine, theme: ChartTheme) {
  const { plot } = engine;
  const bottom = plot.top + plot.height;
  const sel = engine.selection;
  if (sel) {
    const a = Math.min(sel.from, sel.to);
    const w = Math.abs(sel.to - sel.from);
    cx.globalAlpha = 0.14;
    cx.fillStyle = theme.selection;
    cx.fillRect(a, plot.top, w, plot.height);
    cx.globalAlpha = 1;
    cx.strokeStyle = theme.selection;
    cx.lineWidth = 1;
    cx.beginPath();
    cx.moveTo(crisp(a), plot.top);
    cx.lineTo(crisp(a), bottom);
    cx.moveTo(crisp(a + w), plot.top);
    cx.lineTo(crisp(a + w), bottom);
    cx.stroke();
  }
  const st = engine.store;
  const i = engine.cursorIndex;
  if (!st || i < 0 || i >= st.length()) return;
  const x = engine.toPx(st.x(i));
  if (x < plot.left - 0.5 || x > plot.left + plot.width + 0.5) return;
  cx.strokeStyle = theme.cursor;
  cx.lineWidth = 1;
  cx.setLineDash([3, 3]);
  cx.beginPath();
  cx.moveTo(crisp(x), plot.top);
  cx.lineTo(crisp(x), bottom);
  cx.stroke();
  cx.setLineDash([]);
  // A dot on each shown series, ringed with the surface so it reads over the lines.
  for (const s of engine.series) {
    if (!s.show || s.index >= st.seriesCount) continue;
    const v = st.y(s.index, i);
    if (v !== v || v < engine.y0 || v > engine.y1) continue;
    const y = engine.toPy(v);
    cx.beginPath();
    cx.arc(r(x), r(y), 4, 0, Math.PI * 2);
    cx.fillStyle = theme.surface;
    cx.fill();
    cx.beginPath();
    cx.arc(r(x), r(y), 2.75, 0, Math.PI * 2);
    cx.fillStyle = s.color;
    cx.fill();
  }
  // The time under the crosshair, on the x axis.
  const text = engine.cursorTimeText();
  if (!text) return;
  const font = fontOf(theme);
  cx.font = font;
  const w = measureCached(cx, font, text) + 12;
  const h = theme.fontSize + 8;
  const left = Math.max(0, Math.min(engine.width - w, x - w / 2));
  const top = bottom + 2;
  cx.fillStyle = theme.text;
  if (cx.roundRect) {
    cx.beginPath();
    cx.roundRect(r(left), r(top), r(w), h, 4);
    cx.fill();
  } else cx.fillRect(r(left), r(top), r(w), h);
  cx.fillStyle = theme.surface;
  cx.textAlign = "center";
  cx.textBaseline = "middle";
  cx.fillText(text, r(left + w / 2), r(top + h / 2));
}
