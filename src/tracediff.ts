/**
 * Two traces of one operation, side by side: spans matched by where they sit in the tree (the chain of
 * service and name from the root, and which repeat of it among its siblings), so a row is "the same
 * call" in both. Each row says how its duration changed, or that the call is new or gone. The model,
 * engine and renderer are plain TypeScript, as the waterfall's are.
 */
import { drawTooltip, fitText, r1, RectBatch, type TooltipLine } from "./draw";
import { fontOf, measureCached, type Ctx2D, type PathFactory } from "./render";
import { formatValue, valueTicks } from "./scale";
import type { Span, TraceModel } from "./traces";
import type { ChartTheme } from "./types";

export interface ComparisonRow {
  /** The call in the baseline trace and in the other one; one may be missing. */
  a?: Span;
  b?: Span;
  depth: number;
  name: string;
  service: string;
  /** b's duration less a's (NaN when one is missing). */
  delta: number;
  /** delta / a's duration (Infinity for a new call, -1 for a gone one). */
  ratio: number;
}

export const SLOWER = "#e34948";
export const FASTER = "#2a78d6";

/**
 * Matches the spans of `a` (the baseline) and `b`, depth-first. Children are paired by service and name,
 * the k-th repeat with the k-th (retries line up in order); unmatched ones are kept, with only one side.
 */
export function compareTraces(a: TraceModel, b: TraceModel): ComparisonRow[] {
  const out: ComparisonRow[] = [];
  const key = (s: Span) => `${s.service}\u0000${s.name}`;
  const pair = (as: readonly Span[], bs: readonly Span[]) => {
    const pending = new Map<string, Span[]>();
    for (const s of bs) {
      const k = key(s);
      const list = pending.get(k);
      if (list) list.push(s);
      else pending.set(k, [s]);
    }
    const pairs: [Span | undefined, Span | undefined][] = [];
    for (const s of as) pairs.push([s, pending.get(key(s))?.shift()]);
    // What b has left are its new calls, placed after a's in start order.
    for (const s of bs) if (pending.get(key(s))?.includes(s)) pairs.push([undefined, s]);
    return pairs;
  };
  const walk = (sa: Span | undefined, sb: Span | undefined, depth: number) => {
    const s = (sa ?? sb)!;
    const delta = sa && sb ? sb.duration - sa.duration : NaN;
    out.push({
      a: sa,
      b: sb,
      depth,
      name: s.name,
      service: s.service,
      delta,
      ratio: sa && sb ? (sa.duration > 0 ? delta / sa.duration : 0) : sb ? Infinity : -1,
    });
    for (const [ca, cb] of pair(sa ? a.children(sa) : [], sb ? b.children(sb) : [])) walk(ca, cb, depth + 1);
  };
  for (const [ra, rb] of pair(a.roots, b.roots)) walk(ra, rb, 0);
  return out;
}

export class ComparisonEngine {
  width = 0;
  height = 0;
  rowHeight = 30;
  header = 26;
  labelWidth = 300;
  /** Every matched call, depth-first. */
  all: ComparisonRow[] = [];
  /** The rows shown: all of them, or with `changedOnly` the changed ones and the calls above them. */
  rows: ComparisonRow[] = [];
  private changed = false;
  a: TraceModel | null = null;
  b: TraceModel | null = null;
  /** The longer trace's duration: both are drawn on one scale, from their own starts. */
  span = 1;
  scrollY = 0;
  hover = -1;
  pointer = { x: 0, y: 0 };
  /** Changes smaller than this (ms, and as a share of the call) stay neutral: noise. */
  threshold = { ms: 1, ratio: 0.1 };
  ticks: number[] = [];
  measure: (t: string) => number = (t) => t.length * 6;

  set(a: TraceModel, b: TraceModel) {
    this.a = a;
    this.b = b;
    this.all = compareTraces(a, b);
    this.span = Math.max(1e-6, a.duration, b.duration);
    this.scrollY = 0;
    this.hover = -1;
    this.filter();
  }

  get changedOnly() {
    return this.changed;
  }

  /** Hides the calls that stayed the same, unless something changed below them. */
  set changedOnly(on: boolean) {
    if (on === this.changed) return;
    this.changed = on;
    this.hover = -1;
    this.filter();
    this.clampScroll();
  }

  /** How many rows `changedOnly` hides. */
  get hidden() {
    return this.all.length - this.rows.length;
  }

  private filter() {
    if (!this.changed) {
      this.rows = this.all;
      return;
    }
    // Backwards through the depth-first rows: a row's descendants come right after it, so by the time
    // it is reached, need[depth + 1] says whether any of them is kept.
    const keep = new Uint8Array(this.all.length);
    const need: boolean[] = [];
    for (let i = this.all.length - 1; i >= 0; i--) {
      const r = this.all[i];
      const k = this.kind(r) !== "same" || need[r.depth + 1] === true;
      need[r.depth + 1] = false;
      if (k) {
        keep[i] = 1;
        need[r.depth] = true;
      }
    }
    this.rows = this.all.filter((_, i) => keep[i]);
  }

  setSize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.clampScroll();
  }

  get label() {
    return Math.min(this.labelWidth, Math.max(140, this.width * 0.4));
  }

  get timeline() {
    const left = this.label + 8;
    return { left, width: Math.max(1, this.width - left - 90) };
  }

  toPx(rel: number) {
    const t = this.timeline;
    return t.left + (rel / this.span) * t.width;
  }

  clampScroll() {
    const max = Math.max(0, this.rows.length * this.rowHeight - (this.height - this.header));
    this.scrollY = Math.max(0, Math.min(max, this.scrollY));
  }

  scrollBy(dy: number) {
    this.scrollY += dy;
    this.clampScroll();
  }

  rowAt(y: number) {
    if (y < this.header) return -1;
    const i = Math.floor((y - this.header + this.scrollY) / this.rowHeight);
    return i >= 0 && i < this.rows.length ? i : -1;
  }

  rowTop(i: number) {
    return this.header + i * this.rowHeight - this.scrollY;
  }

  /** "slower", "faster", "same", "new" or "gone". */
  kind(r: ComparisonRow) {
    if (!r.a) return "new";
    if (!r.b) return "gone";
    if (Math.abs(r.delta) < this.threshold.ms || Math.abs(r.ratio) < this.threshold.ratio) return "same";
    return r.delta > 0 ? "slower" : "faster";
  }

  colorOf(r: ComparisonRow, muted: string) {
    const k = this.kind(r);
    return k === "slower" || k === "new" ? SLOWER : k === "faster" || k === "gone" ? FASTER : muted;
  }

  /** How the row's change reads: "41 ms → 210 ms (+169 ms)", "new: 12 ms", "gone: 8 ms". */
  changeText(r: ComparisonRow) {
    if (!r.a) return `new · ${formatValue(r.b!.duration, "ms")}`;
    if (!r.b) return `gone · ${formatValue(r.a.duration, "ms")}`;
    const sign = r.delta >= 0 ? "+" : "−";
    return `${formatValue(r.a.duration, "ms")} → ${formatValue(r.b.duration, "ms")} (${sign}${formatValue(Math.abs(r.delta), "ms")})`;
  }

  rowLines(i: number): TooltipLine[] {
    const r = this.rows[i];
    if (!r) return [];
    const lines: TooltipLine[] = [{ text: r.name }, { text: r.service, muted: true }, { text: this.changeText(r), color: this.kind(r) === "same" ? undefined : this.colorOf(r, "") }];
    if (r.a && r.b && this.kind(r) !== "same") lines.push({ text: `${r.delta > 0 ? "+" : "−"}${Math.abs(r.ratio * 100).toFixed(0)}%`, muted: true });
    if (r.b?.status === "error" && r.a?.status !== "error") lines.push({ text: "fails here, not in the baseline", color: SLOWER });
    return lines;
  }

  /** The rows that changed most, slowest first: where to look. */
  biggest(n = 5): ComparisonRow[] {
    return this.all
      .filter((r) => this.kind(r) === "slower" || this.kind(r) === "new")
      .sort((x, y) => (y.b?.duration ?? 0) - (y.a?.duration ?? 0) - ((x.b?.duration ?? 0) - (x.a?.duration ?? 0)))
      .slice(0, n);
  }
}

/** Two thin bars a row: the baseline's above (muted), the other below (colored by the change). */
export function renderComparison(cx: Ctx2D, e: ComparisonEngine, theme: ChartTheme, path: PathFactory) {
  const font = fontOf(theme);
  const rh = e.rowHeight;
  const tl = e.timeline;
  if (theme.background) {
    cx.fillStyle = theme.background;
    cx.fillRect(0, 0, e.width, e.height);
  }
  e.ticks = valueTicks(0, e.span, tl.width, 90);
  cx.font = font;
  const first = Math.max(0, Math.floor(e.scrollY / rh));
  const last = Math.min(e.rows.length - 1, Math.ceil((e.scrollY + e.height - e.header) / rh));
  cx.save();
  cx.beginPath();
  cx.rect(0, e.header, e.width, e.height - e.header);
  cx.clip();
  const zebra = new RectBatch();
  for (let i = first; i <= last; i++) if (i % 2) zebra.add(theme.grid, 0, e.rowTop(i), e.width, rh);
  zebra.fill(cx, path, 0.5);
  let grid = "";
  for (const v of e.ticks) {
    const x = Math.round(e.toPx(v)) + 0.5;
    grid += `M${x} ${e.header}V${e.height}`;
  }
  cx.strokeStyle = theme.grid;
  cx.lineWidth = 1;
  if (grid) cx.stroke(path(grid));
  const bars = new RectBatch();
  const bh = Math.max(3, Math.round(rh * 0.22));
  const a0 = e.a?.start ?? 0;
  const b0 = e.b?.start ?? 0;
  for (let i = first; i <= last; i++) {
    const r = e.rows[i];
    const y = e.rowTop(i);
    if (r.a) {
      const x = e.toPx(r.a.start - a0);
      bars.add(theme.muted, x, y + rh / 2 - bh - 1, Math.max(1, e.toPx(r.a.start - a0 + r.a.duration) - x), bh);
    }
    if (r.b) {
      const x = e.toPx(r.b.start - b0);
      bars.add(e.colorOf(r, theme.text), x, y + rh / 2 + 1, Math.max(1, e.toPx(r.b.start - b0 + r.b.duration) - x), bh);
    }
  }
  bars.fill(cx, path);
  cx.textBaseline = "middle";
  for (let i = first; i <= last; i++) {
    const r = e.rows[i];
    const y = e.rowTop(i) + rh / 2;
    const x = 8 + r.depth * 14;
    const k = e.kind(r);
    cx.textAlign = "left";
    cx.fillStyle = k === "gone" ? theme.muted : r.b?.status === "error" ? SLOWER : theme.text;
    const name = fitText(cx, font, r.name, e.label - x - 8);
    cx.fillText(name, r1(x), r1(y));
    const used = measureCached(cx, font, name);
    const svc = fitText(cx, font, r.service, e.label - x - used - 16);
    if (svc) {
      cx.fillStyle = theme.muted;
      cx.fillText(svc, r1(x + used + 8), r1(y));
    }
    // The change, right-aligned past the timeline: signed delta, or new / gone.
    const text = k === "new" ? "new" : k === "gone" ? "gone" : `${r.delta >= 0 ? "+" : "−"}${formatValue(Math.abs(r.delta), "ms")}`;
    cx.textAlign = "right";
    cx.fillStyle = k === "same" ? theme.muted : e.colorOf(r, theme.muted);
    cx.fillText(text, r1(e.width - 6), r1(y));
  }
  cx.restore();
  // The axis.
  cx.strokeStyle = theme.grid;
  cx.beginPath();
  cx.moveTo(0, e.header - 0.5);
  cx.lineTo(e.width, e.header - 0.5);
  cx.stroke();
  cx.fillStyle = theme.muted;
  cx.textBaseline = "middle";
  cx.textAlign = "left";
  const a = e.a;
  const b = e.b;
  cx.fillText(fitText(cx, font, a && b ? `${formatValue(a.duration, "ms")} → ${formatValue(b.duration, "ms")}` : "", e.label - 12), 8, r1(e.header / 2));
  cx.textAlign = "center";
  const step = e.ticks.length > 1 ? e.ticks[1] - e.ticks[0] : e.span;
  let lastRight = tl.left - 4;
  for (const v of e.ticks) {
    const label = formatValue(v, "ms", step);
    const w = measureCached(cx, font, label);
    const x = Math.max(tl.left + w / 2, e.toPx(v));
    if (x - w / 2 < lastRight + 6) continue;
    cx.fillText(label, r1(x), r1(e.header / 2));
    lastRight = x + w / 2;
  }
}

export function renderComparisonOverlay(cx: Ctx2D, e: ComparisonEngine, theme: ChartTheme) {
  if (e.hover < 0) return;
  cx.save();
  cx.beginPath();
  cx.rect(0, e.header, e.width, e.height - e.header);
  cx.clip();
  cx.globalAlpha = 0.07;
  cx.fillStyle = theme.text;
  cx.fillRect(0, r1(e.rowTop(e.hover)), e.width, e.rowHeight);
  cx.globalAlpha = 1;
  cx.restore();
  drawTooltip(cx, theme, e.rowLines(e.hover), e.pointer.x, e.pointer.y, e.width, e.height);
}
