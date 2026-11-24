/**
 * The trace waterfall's engine and renderer: a column of span names (indented as a tree, with a toggle on
 * spans that have children) and a timeline of bars, one row per span, scrolled vertically and zoomed in
 * time. Only the rows in view are drawn. Plain TypeScript, as `ChartEngine` is.
 */
import { drawTooltip, fitText, r1, RectBatch, type TooltipLine } from "./draw";
import { fontOf, measureCached, type Ctx2D, type PathFactory } from "./render";
import { formatValue, valueTicks } from "./scale";
import type { SpanEvent, TraceModel, WaterfallRow } from "./traces";
import type { ChartTheme } from "./types";

export const ERROR_COLOR = "#e34948";

/** An exception or error event (OpenTelemetry names them "exception"): drawn red. */
export function isErrorEvent(ev: SpanEvent) {
  return /exception|error|fail/i.test(ev.name);
}

export interface WaterfallOptions {
  rowHeight: number;
  /** The name column's width; the timeline gets the rest. */
  labelWidth: number;
  /** Mark the critical path. */
  criticalPath: boolean;
  /** An overview of the whole trace above the time axis, the range in view marked on it. */
  minimap: boolean;
}

export class WaterfallEngine {
  width = 0;
  height = 0;
  options: WaterfallOptions = { rowHeight: 22, labelWidth: 280, criticalPath: true, minimap: true };
  model: TraceModel | null = null;
  rows: WaterfallRow[] = [];
  /** The time in view, relative to the trace's start (ms). */
  v0 = 0;
  v1 = 1;
  zoomed = false;
  scrollY = 0;
  /** The time axis row's height. */
  axis = 26;
  /** The overview row's height (0 without one). */
  get mini() {
    return this.options.minimap ? 38 : 0;
  }
  /** What sits above the rows: the overview and the time axis. */
  get header() {
    return this.mini + this.axis;
  }
  /** A drag across the overview, in points. */
  miniSelection: { from: number; to: number } | null = null;
  private miniCache: { key: string; paths: [string, string][] } | null = null;
  selected = -1;
  hover = -1;
  pointer = { x: 0, y: 0 };
  selection: { from: number; to: number } | null = null;
  ticks: number[] = [];
  tickStep = 0;
  services = new Map<string, string>();
  critical = new Set<string>();
  measure: (t: string) => number = (t) => t.length * 6;

  setModel(model: TraceModel | null, palette: readonly string[]) {
    this.model = model;
    this.services.clear();
    if (model) model.services.forEach((s, i) => this.services.set(s, palette[i % palette.length]));
    this.critical = model ? model.criticalPath() : new Set();
    this.miniCache = null;
    if (!this.zoomed) this.reset();
  }

  setRows(rows: WaterfallRow[]) {
    this.rows = rows;
    if (this.selected >= rows.length) this.selected = rows.length - 1;
    this.clampScroll();
  }

  setSize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.clampScroll();
    this.ticks = [];
  }

  get labelWidth() {
    return Math.min(this.options.labelWidth, Math.max(120, this.width * 0.45));
  }

  /** The timeline's rectangle: right of the names, under the header. */
  get timeline() {
    const left = this.labelWidth + 8;
    return { left, top: this.header, width: Math.max(1, this.width - left - 12), height: Math.max(1, this.height - this.header) };
  }

  get duration() {
    return this.model ? Math.max(1e-6, this.model.duration) : 1;
  }

  reset() {
    this.v0 = 0;
    this.v1 = this.duration;
    this.zoomed = false;
  }

  setView(a: number, b: number) {
    const d = this.duration;
    const minSpan = d / 1e6;
    if (b - a < minSpan) {
      const m = (a + b) / 2;
      a = m - minSpan / 2;
      b = m + minSpan / 2;
    }
    const span = Math.min(d, b - a);
    a = Math.max(0, Math.min(d - span, a));
    this.v0 = a;
    this.v1 = a + span;
    this.zoomed = this.v0 > 0 || this.v1 < d;
  }

  toPx(rel: number) {
    const t = this.timeline;
    return t.left + ((rel - this.v0) / (this.v1 - this.v0)) * t.width;
  }

  fromPx(px: number) {
    const t = this.timeline;
    return this.v0 + ((px - t.left) / t.width) * (this.v1 - this.v0);
  }

  zoomAt(factor: number, px: number) {
    const at = this.fromPx(px);
    const span = (this.v1 - this.v0) / factor;
    const f = (at - this.v0) / (this.v1 - this.v0);
    this.setView(at - f * span, at - f * span + span);
  }

  panBy(dx: number) {
    const d = (dx / this.timeline.width) * (this.v1 - this.v0);
    this.setView(this.v0 - d, this.v1 - d);
  }

  get contentHeight() {
    return this.rows.length * this.options.rowHeight;
  }

  clampScroll() {
    const max = Math.max(0, this.contentHeight - (this.height - this.header));
    this.scrollY = Math.max(0, Math.min(max, this.scrollY));
  }

  scrollBy(dy: number) {
    this.scrollY += dy;
    this.clampScroll();
  }

  /** Scrolls row i into view. */
  reveal(i: number) {
    const rh = this.options.rowHeight;
    const view = this.height - this.header;
    if (i * rh < this.scrollY) this.scrollY = i * rh;
    else if ((i + 1) * rh > this.scrollY + view) this.scrollY = (i + 1) * rh - view;
    this.clampScroll();
  }

  /** The row at y points, or -1. */
  rowAt(y: number) {
    if (y < this.header) return -1;
    const i = Math.floor((y - this.header + this.scrollY) / this.options.rowHeight);
    return i >= 0 && i < this.rows.length ? i : -1;
  }

  rowTop(i: number) {
    return this.header + i * this.options.rowHeight - this.scrollY;
  }

  /** Where row i's toggle is (x from, x to), or null when the span has no children. */
  toggleAt(i: number): [number, number] | null {
    const row = this.rows[i];
    if (!row || !row.children) return null;
    const x = 6 + row.depth * 14;
    return [x - 4, x + 14];
  }

  inTimeline(x: number, y: number) {
    const t = this.timeline;
    return x >= t.left && x <= t.left + t.width && y >= this.header;
  }

  endSelection(): [number, number] | null {
    const s = this.selection;
    this.selection = null;
    if (!s || Math.abs(s.to - s.from) < 4) return null;
    const t = this.timeline;
    const a = this.fromPx(Math.max(t.left, Math.min(s.from, s.to)));
    const b = this.fromPx(Math.min(t.left + t.width, Math.max(s.from, s.to)));
    return b > a ? [a, b] : null;
  }

  /** In the overview: x of a time (ms from the trace's start) over the whole trace, and back. */
  miniPx(rel: number) {
    const t = this.timeline;
    return t.left + (rel / this.duration) * t.width;
  }

  miniTime(px: number) {
    const t = this.timeline;
    return Math.max(0, Math.min(this.duration, ((px - t.left) / t.width) * this.duration));
  }

  inMinimap(x: number, y: number) {
    const t = this.timeline;
    return this.mini > 0 && y < this.mini && x >= t.left - 4 && x <= t.left + t.width + 4;
  }

  /** The range a drag across the overview picked, or null for a tap. */
  endMiniSelection(): [number, number] | null {
    const s = this.miniSelection;
    this.miniSelection = null;
    if (!s || Math.abs(s.to - s.from) < 4) return null;
    return [this.miniTime(Math.min(s.from, s.to)), this.miniTime(Math.max(s.from, s.to))];
  }

  /** Moves the range in view to center on the overview's x, keeping its width. */
  centerAt(px: number) {
    const span = this.v1 - this.v0;
    const at = this.miniTime(px);
    this.setView(at - span / 2, at + span / 2);
  }

  /**
   * The overview's bars: every span (folded or not), one thin row each in tree order, squeezed into the
   * overview's height; one path per service color, made again only when the trace or the width changes.
   */
  miniPaths(): [string, string][] {
    const m = this.model;
    const t = this.timeline;
    const key = `${t.left}|${t.width}|${this.mini}`;
    if (this.miniCache && this.miniCache.key === key) return this.miniCache.paths;
    const paths = new Map<string, string>();
    if (m && this.mini > 0) {
      const all = m.rows();
      const top = 5;
      const h = this.mini - 10;
      const rh = Math.max(0.5, Math.min(3, h / Math.max(1, all.length)));
      all.forEach((row, i) => {
        const s = row.span;
        const x = this.miniPx(s.start - m.start);
        const w = Math.max(0.75, (s.duration / this.duration) * t.width);
        const y = top + (all.length > 1 ? (i / (all.length - 1)) * (h - rh) : 0);
        const c = this.colorOf(row);
        paths.set(c, (paths.get(c) ?? "") + `M${r1(x)} ${r1(y)}h${r1(w)}v${r1(rh)}h${r1(-w)}z`);
      });
    }
    this.miniCache = { key, paths: [...paths] };
    return this.miniCache.paths;
  }

  updateTicks() {
    const t = this.timeline;
    const span = this.v1 - this.v0;
    const ticks = valueTicks(this.v0, this.v1, t.width, 90);
    this.ticks = ticks;
    this.tickStep = ticks.length > 1 ? ticks[1] - ticks[0] : span;
  }

  colorOf(row: WaterfallRow) {
    return this.services.get(row.span.service) ?? "#888888";
  }

  /** What the tooltip says about row i. */
  rowLines(i: number): TooltipLine[] {
    const row = this.rows[i];
    if (!row || !this.model) return [];
    const s = row.span;
    const lines: TooltipLine[] = [
      { text: s.name, color: this.colorOf(row) },
      { text: `${s.service}${s.kind ? ` · ${s.kind}` : ""}`, muted: true },
      { text: `duration ${formatValue(s.duration, "ms")} · self ${formatValue(row.self, "ms")}` },
      { text: `starts at +${formatValue(s.start - this.model.start, "ms")}`, muted: true },
    ];
    if (s.status === "error") lines.push({ text: "error", color: ERROR_COLOR });
    const evs = s.events ?? [];
    for (const ev of evs.slice(0, 4)) lines.push({ text: `◆ ${ev.name} at +${formatValue(ev.time - this.model.start, "ms")}`, color: isErrorEvent(ev) ? ERROR_COLOR : undefined, muted: !isErrorEvent(ev) });
    if (evs.length > 4) lines.push({ text: `+${evs.length - 4} more events`, muted: true });
    return lines;
  }
}

/** Names, bars, the time axis. */
export function renderWaterfall(cx: Ctx2D, e: WaterfallEngine, theme: ChartTheme, path: PathFactory) {
  const font = fontOf(theme);
  const rh = e.options.rowHeight;
  const tl = e.timeline;
  const m = e.model;
  e.updateTicks();
  if (theme.background) {
    cx.fillStyle = theme.background;
    cx.fillRect(0, 0, e.width, e.height);
  }
  cx.font = font;
  const first = Math.max(0, Math.floor(e.scrollY / rh));
  const last = Math.min(e.rows.length - 1, Math.ceil((e.scrollY + e.height - e.header) / rh));

  // Zebra rows, the selected one, and the grid at the time ticks.
  const zebra = new RectBatch();
  for (let i = first; i <= last; i++) if (i % 2 === 1) zebra.add(theme.grid, 0, e.rowTop(i), e.width, rh);
  cx.save();
  cx.beginPath();
  cx.rect(0, e.header, e.width, e.height - e.header);
  cx.clip();
  zebra.fill(cx, path, 0.5);
  if (e.selected >= first && e.selected <= last) {
    cx.globalAlpha = 0.14;
    cx.fillStyle = theme.selection;
    cx.fillRect(0, r1(e.rowTop(e.selected)), e.width, rh);
    cx.globalAlpha = 1;
  }
  let grid = "";
  for (const v of e.ticks) {
    const x = Math.round(e.toPx(v)) + 0.5;
    if (x < tl.left - 0.5 || x > tl.left + tl.width + 0.5) continue;
    grid += `M${x} ${e.header}V${e.height}`;
  }
  grid += `M${Math.round(e.labelWidth) + 0.5} 0V${e.height}`;
  cx.strokeStyle = theme.grid;
  cx.lineWidth = 1;
  cx.stroke(path(grid));

  if (m) {
    // Bars, batched by color; errors outlined; the critical path underlined.
    const bars = new RectBatch();
    let errors = "";
    let crit = "";
    let toggles = "";
    let marks = "";
    let errMarks = "";
    const bh = Math.max(4, Math.round(rh * 0.5));
    for (let i = first; i <= last; i++) {
      const row = e.rows[i];
      const s = row.span;
      const y = e.rowTop(i);
      const a = e.toPx(s.start - m.start);
      const b = e.toPx(s.start - m.start + s.duration);
      const l = Math.max(tl.left, a);
      const rr = Math.min(tl.left + tl.width, Math.max(b, a + 1));
      const by = y + (rh - bh) / 2;
      if (rr > l) {
        bars.add(e.colorOf(row), l, by, Math.max(1, rr - l), bh);
        if (s.status === "error") errors += `M${r1(l) + 0.5} ${r1(by) + 0.5}h${r1(Math.max(1, rr - l) - 1)}v${bh - 1}h${r1(-(Math.max(1, rr - l) - 1))}z`;
        if (e.options.criticalPath && e.critical.has(s.spanId)) crit += `M${r1(l)} ${r1(by + bh + 2)}H${r1(rr)}`;
      }
      // Span events: a diamond on the bar at each one's time, red for exceptions.
      if (s.events) {
        const cy = y + rh / 2;
        for (const ev of s.events) {
          const x = e.toPx(ev.time - m.start);
          if (x < tl.left - 4 || x > tl.left + tl.width + 4) continue;
          const d = `M${r1(x)} ${r1(cy - 4)}L${r1(x + 4)} ${r1(cy)}L${r1(x)} ${r1(cy + 4)}L${r1(x - 4)} ${r1(cy)}Z`;
          if (isErrorEvent(ev)) errMarks += d;
          else marks += d;
        }
      }
      // A triangle toggle: pointing down when open, right when collapsed.
      if (row.children) {
        const tx = 6 + row.depth * 14;
        const ty = y + rh / 2;
        toggles += row.collapsed ? `M${tx + 2} ${ty - 4}L${tx + 6} ${ty}L${tx + 2} ${ty + 4}Z` : `M${tx} ${ty - 2}L${tx + 8} ${ty - 2}L${tx + 4} ${ty + 2.5}Z`;
      }
    }
    bars.fill(cx, path);
    if (errors) {
      cx.strokeStyle = ERROR_COLOR;
      cx.lineWidth = 1.5;
      cx.stroke(path(errors));
    }
    if (crit) {
      cx.strokeStyle = theme.text;
      cx.lineWidth = 1.5;
      cx.globalAlpha = 0.6;
      cx.stroke(path(crit));
      cx.globalAlpha = 1;
    }
    if (toggles) {
      cx.fillStyle = theme.muted;
      cx.fill(path(toggles));
    }
    for (const [d, color] of [[marks, theme.text], [errMarks, ERROR_COLOR]] as const) {
      if (!d) continue;
      const p = path(d);
      cx.fillStyle = theme.surface;
      cx.fill(p);
      cx.strokeStyle = color;
      cx.lineWidth = 1.5;
      cx.stroke(p);
    }

    // Names: service dot, name, with the service muted after it; the duration by the bar.
    cx.textBaseline = "middle";
    const dots = new RectBatch();
    for (let i = first; i <= last; i++) {
      const row = e.rows[i];
      const s = row.span;
      const y = e.rowTop(i) + rh / 2;
      const x = 6 + row.depth * 14 + 14;
      dots.add(e.colorOf(row), x, y - 4, 3, 8);
      const nameMax = e.labelWidth - x - 14;
      cx.textAlign = "left";
      cx.fillStyle = s.status === "error" ? ERROR_COLOR : theme.text;
      const name = fitText(cx, font, s.name, nameMax);
      cx.fillText(name, r1(x + 8), r1(y));
      const used = measureCached(cx, font, name);
      const svc = fitText(cx, font, s.service, nameMax - used - 8);
      if (svc) {
        cx.fillStyle = theme.muted;
        cx.fillText(svc, r1(x + 8 + used + 8), r1(y));
      }
      // Duration after the bar, or before it when there is no room after.
      const label = formatValue(s.duration, "ms");
      const w = measureCached(cx, font, label);
      const a = e.toPx(s.start - m.start);
      const b = e.toPx(s.start - m.start + s.duration);
      cx.fillStyle = theme.muted;
      if (b + 6 + w <= tl.left + tl.width && b >= tl.left - w) {
        cx.textAlign = "left";
        cx.fillText(label, r1(Math.max(tl.left, b) + 6), r1(y));
      } else if (a - 6 - w >= tl.left && a <= tl.left + tl.width + w) {
        cx.textAlign = "right";
        cx.fillText(label, r1(Math.min(tl.left + tl.width, a) - 6), r1(y));
      }
    }
    dots.fill(cx, path);
  }
  cx.restore();

  // Header: the overview, then the time axis. Unfilled: the rows are clipped below it, so it shows whatever
  // the waterfall sits on (a card is often not the page's background).
  if (theme.background) {
    cx.fillStyle = theme.background;
    cx.fillRect(0, 0, e.width, e.header);
  }
  cx.strokeStyle = theme.grid;
  cx.lineWidth = 1;
  cx.beginPath();
  cx.moveTo(0, e.header - 0.5);
  cx.lineTo(e.width, e.header - 0.5);
  if (e.mini > 0) {
    cx.moveTo(0, e.mini - 0.5);
    cx.lineTo(e.width, e.mini - 0.5);
  }
  cx.stroke();
  const summary = m ? `${m.spans.length} spans · ${m.services.length} services · ${formatValue(m.duration, "ms")}` : "No trace";
  if (e.mini > 0) {
    // Zoomed: every bar faded, then the range in view drawn again at full strength and outlined. No veil
    // of a background color, which would have to match whatever the waterfall sits on.
    const paths = e.miniPaths().map(([color, d]) => [color, path(d)] as const);
    const draw = () => {
      for (const [color, p] of paths) {
        cx.fillStyle = color;
        cx.fill(p);
      }
    };
    if (!e.zoomed) draw();
    else {
      const a = e.miniPx(e.v0);
      const b = e.miniPx(e.v1);
      cx.globalAlpha = 0.3;
      draw();
      cx.globalAlpha = 1;
      cx.save();
      cx.beginPath();
      cx.rect(r1(a), 0, r1(Math.max(1, b - a)), e.mini);
      cx.clip();
      draw();
      cx.restore();
      cx.strokeStyle = theme.selection;
      cx.lineWidth = 1.5;
      cx.beginPath();
      cx.rect(r1(a), 2, r1(Math.max(2, b - a)), e.mini - 4);
      cx.stroke();
    }
  }
  cx.fillStyle = theme.muted;
  cx.textBaseline = "middle";
  cx.textAlign = "left";
  cx.fillText(fitText(cx, font, summary, e.labelWidth - 12), 6, r1(e.mini > 0 ? e.mini / 2 : e.header / 2));
  if (e.mini > 0) cx.fillText(e.zoomed ? `${formatValue(e.v1 - e.v0, "ms")} in view` : "", 6, r1(e.mini + e.axis / 2));
  cx.textAlign = "center";
  let lastRight = tl.left - 4;
  for (const v of e.ticks) {
    const label = formatValue(v, "ms", e.tickStep);
    const w = measureCached(cx, font, label);
    const x = Math.max(tl.left + w / 2, Math.min(e.width - w / 2 - 2, e.toPx(v)));
    if (x - w / 2 < lastRight + 6) continue;
    cx.fillText(label, r1(x), r1(e.mini + e.axis / 2));
    lastRight = x + w / 2;
  }
}

/** The hovered row, the zoom box and the tooltip. */
export function renderWaterfallOverlay(cx: Ctx2D, e: WaterfallEngine, theme: ChartTheme) {
  const tl = e.timeline;
  const rh = e.options.rowHeight;
  cx.save();
  cx.beginPath();
  cx.rect(0, e.header, e.width, e.height - e.header);
  cx.clip();
  if (e.hover >= 0) {
    cx.globalAlpha = 0.07;
    cx.fillStyle = theme.text;
    cx.fillRect(0, r1(e.rowTop(e.hover)), e.width, rh);
    cx.globalAlpha = 1;
  }
  const s = e.selection;
  if (s) {
    const a = Math.max(tl.left, Math.min(s.from, s.to));
    const b = Math.min(tl.left + tl.width, Math.max(s.from, s.to));
    cx.globalAlpha = 0.14;
    cx.fillStyle = theme.selection;
    cx.fillRect(r1(a), e.header, r1(b - a), e.height - e.header);
    cx.globalAlpha = 1;
  }
  cx.restore();
  const ms = e.miniSelection;
  if (ms) {
    const a = Math.max(tl.left, Math.min(ms.from, ms.to));
    const b = Math.min(tl.left + tl.width, Math.max(ms.from, ms.to));
    cx.globalAlpha = 0.2;
    cx.fillStyle = theme.selection;
    cx.fillRect(r1(a), 1, r1(b - a), e.mini - 2);
    cx.globalAlpha = 1;
  }
  if (!s && e.hover >= 0 && e.pointer.x > e.labelWidth) drawTooltip(cx, theme, e.rowLines(e.hover), e.pointer.x, e.pointer.y, e.width, e.height);
}
