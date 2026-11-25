/**
 * The state of one chart, apart from drawing and input: the store, the series, the plot area, the
 * viewport (x range followed or zoomed, y range auto-scaled), the cursor and the drag-to-zoom box.
 * Plain TypeScript with no NSH imports, so it runs headless.
 */
import { formatTimeFull, formatValue, niceRange, timeTicks, valueTicks, type Tick, type TimeZone, type Unit } from "./scale";
import type { SeriesStore } from "./store";
import type { Annotation, AxisOptions, AxisSide, CursorInfo, ResolvedSeries, SeriesOptions, Threshold } from "./types";

export interface ChartOptions {
  unit: Unit;
  /** The second y axis, for the series with `axis: "right"`: its unit and range. */
  y2: AxisOptions;
  /** Fixed ends of the y range; null or absent ends auto-scale. */
  yMin: number | null;
  yMax: number | null;
  /** Kept inside the auto-scaled y range (0 for counts and rates). */
  softMin: number | undefined;
  softMax: number | undefined;
  /** Live: show the last `window` ms, following the data. 0: everything. */
  window: number;
  timeZone: TimeZone;
  thresholds: Threshold[];
  annotations: Annotation[];
  /** Points between x tick labels, at least. */
  xTickGap: number;
  yTickGap: number;
  fontSize: number;
}

export const DEFAULT_CHART_OPTIONS: ChartOptions = {
  unit: "short",
  y2: {},
  yMin: null,
  yMax: null,
  softMin: undefined,
  softMax: undefined,
  window: 0,
  timeZone: "local",
  thresholds: [],
  annotations: [],
  xTickGap: 90,
  yTickGap: 34,
  fontSize: 11,
};

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The smallest x span a zoom goes to: 1 ms. */
const MIN_SPAN = 1;

export class ChartEngine {
  store: SeriesStore | null = null;
  series: ResolvedSeries[] = [];
  options: ChartOptions = { ...DEFAULT_CHART_OPTIONS };

  width = 0;
  height = 0;
  plot: Rect = { left: 0, top: 0, width: 0, height: 0 };

  /** The x range shown. */
  x0 = 0;
  x1 = 1;
  /** Following the data (the window or the whole range) rather than a range the user zoomed to. */
  follow = true;
  /** The y range shown, worked out by `update()`. */
  y0 = 0;
  y1 = 1;
  /** Some series is on the right axis, so it is laid out and drawn. */
  hasY2 = false;
  /** The right axis's range, worked out by `update()` when there is one. */
  y20 = 0;
  y21 = 1;

  xTicks: Tick[] = [];
  xStep = 0;
  yTicks: number[] = [];
  yStep = 0;
  y2Ticks: number[] = [];
  y2Step = 0;

  /** The cursor's x in points (null: none), and the sample under it. */
  cursorPx: number | null = null;
  cursorIndex = -1;
  /** The drag-to-zoom box, from and to x in points. */
  selection: { from: number; to: number } | null = null;

  /** Ranges zoomed out of, for `back()`. */
  private history: { x0: number; x1: number; follow: boolean }[] = [];
  private yCacheKey = "";

  /** Measures text in the axis font; set by whoever draws (a canvas's `measureText`). */
  measure: (text: string) => number = (t) => t.length * 6.2;

  setSeries(options: SeriesOptions[], palette: readonly string[]) {
    const prev = this.series;
    this.series = options.map((o, i) => {
      const fill = o.fill === true ? 0.12 : typeof o.fill === "number" ? Math.max(0, Math.min(1, o.fill)) : 0;
      return {
        index: i,
        label: o.label,
        color: o.color ?? palette[i % palette.length],
        width: o.width ?? 1.5,
        fill,
        dash: o.dash && o.dash.length ? o.dash : null,
        step: !!o.step,
        spanGaps: !!o.spanGaps,
        // A series the legend hid stays hidden while its options change.
        show: prev[i] && prev[i].label === o.label ? prev[i].show : o.show !== false,
        unit: o.unit,
        axis: o.axis === "right" ? "right" : "left",
      };
    });
    // Hiding every series on the right keeps its axis, so the plot does not jump.
    this.hasY2 = this.series.some((s) => s.axis === "right");
    this.yCacheKey = "";
  }

  setStore(store: SeriesStore | null) {
    this.store = store;
    this.yCacheKey = "";
  }

  setOptions(o: Partial<ChartOptions>) {
    this.options = { ...this.options, ...o };
    this.yCacheKey = "";
  }

  setSize(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  toggle(index: number, only = false) {
    const s = this.series[index];
    if (!s) return;
    if (only) {
      // Show only this one, or everything again when it already is the only one.
      const alone = this.series.every((o) => o.show === (o.index === index));
      for (const o of this.series) o.show = alone || o.index === index;
    } else s.show = !s.show;
    this.yCacheKey = "";
  }

  /** The time range of the data, or null when there is none. */
  dataRange(): [number, number] | null {
    const st = this.store;
    if (!st || st.length() === 0) return null;
    return [st.x(0), st.x(st.length() - 1)];
  }

  /** Where the x range goes when following the data. */
  private followRange(): [number, number] {
    const r = this.dataRange();
    if (!r) return [Date.now() - 60_000, Date.now()];
    const w = this.options.window;
    if (w > 0) return [r[1] - w, r[1]];
    if (r[1] - r[0] < MIN_SPAN) return [r[0] - 500, r[1] + 500];
    return r;
  }

  /**
   * Brings everything up to date for a frame: the x range (when following), the plot area, the y range
   * and the ticks.
   */
  update() {
    if (this.follow) {
      const [a, b] = this.followRange();
      this.x0 = a;
      this.x1 = b;
    }
    const o = this.options;
    // y first with a guess at the plot's height, then lay out around its labels.
    const top = Math.round(o.fontSize * 0.75);
    const bottomAxis = Math.round(o.fontSize * 2.2);
    const h = Math.max(1, this.height - top - bottomAxis);
    this.autoY(h);
    this.yTicks = valueTicks(this.y0, this.y1, h, o.yTickGap);
    this.yStep = this.yTicks.length > 1 ? this.yTicks[1] - this.yTicks[0] : this.y1 - this.y0;
    let labelW = 0;
    for (const v of this.yTicks) labelW = Math.max(labelW, this.measure(this.formatY(v)));
    const left = Math.ceil(labelW + 10);
    let right = 12;
    if (this.hasY2) {
      this.y2Ticks = valueTicks(this.y20, this.y21, h, o.yTickGap);
      this.y2Step = this.y2Ticks.length > 1 ? this.y2Ticks[1] - this.y2Ticks[0] : this.y21 - this.y20;
      let w2 = 0;
      for (const v of this.y2Ticks) w2 = Math.max(w2, this.measure(this.formatY2(v)));
      right = Math.ceil(w2 + 10);
    } else {
      this.y2Ticks = [];
      this.y2Step = 0;
    }
    this.plot = { left, top, width: Math.max(1, this.width - left - right), height: h };
    const t = timeTicks(this.x0, this.x1, this.plot.width, o.xTickGap, o.timeZone);
    this.xTicks = t.ticks;
    this.xStep = t.step;
    this.updateCursor();
  }

  /** A label on the left y axis. */
  formatY(v: number) {
    return formatValue(v, this.options.unit, this.yStep || undefined);
  }

  /** A label on the right y axis. */
  formatY2(v: number) {
    return formatValue(v, this.unitOf("right"), this.y2Step || undefined);
  }

  /** The unit an axis's values are in. */
  unitOf(axis: AxisSide): Unit {
    return axis === "right" ? (this.options.y2.unit ?? this.options.unit) : this.options.unit;
  }

  /** The range an axis shows. */
  yRange(axis: AxisSide): [number, number] {
    return axis === "right" ? [this.y20, this.y21] : [this.y0, this.y1];
  }

  private autoY(height: number) {
    const o = this.options;
    const st = this.store;
    const key = `${st?.version}|${this.x0}|${this.x1}|${height}|${this.series.map((s) => (s.show ? 1 : 0)).join("")}`;
    if (key === this.yCacheKey) return;
    this.yCacheKey = key;
    [this.y0, this.y1] = this.scaleAxis("left", height, o.yMin, o.yMax, o.softMin, o.softMax);
    if (this.hasY2) {
      const a = o.y2;
      [this.y20, this.y21] = this.scaleAxis("right", height, a.min ?? null, a.max ?? null, a.softMin, a.softMax);
    }
  }

  /** Fits one axis to its shown series in view, and the thresholds near them. */
  private scaleAxis(
    axis: AxisSide,
    height: number,
    min: number | null,
    max: number | null,
    softMin: number | undefined,
    softMax: number | undefined,
  ): [number, number] {
    const st = this.store;
    let lo = Infinity;
    let hi = -Infinity;
    if (st && st.length() > 0) {
      let i0 = st.lowerBound(this.x0);
      if (i0 > 0) i0--;
      let i1 = st.upperBound(this.x1);
      if (i1 < st.length()) i1++;
      for (const s of this.series) {
        if (!s.show || s.axis !== axis || s.index >= st.seriesCount) continue;
        const [a, b] = st.extent(s.index, i0, i1);
        if (a < lo) lo = a;
        if (b > hi) hi = b;
      }
    }
    for (const t of this.options.thresholds) {
      if ((t.axis ?? "left") !== axis) continue;
      // Thresholds near the data stay in view; far ones don't squash it.
      if (lo <= hi && t.value >= lo - (hi - lo) * 0.5 && t.value <= hi + (hi - lo) * 0.5) {
        lo = Math.min(lo, t.value);
        hi = Math.max(hi, t.value);
      }
    }
    if (min !== null) lo = min;
    if (max !== null) hi = max;
    const [a, b] = niceRange(lo, hi, height, min ?? softMin, max ?? softMax);
    const y0 = min ?? a;
    let y1 = max ?? b;
    if (!(y1 > y0)) y1 = y0 + 1;
    return [y0, y1];
  }

  // ---- Coordinates

  toPx(x: number) {
    return this.plot.left + ((x - this.x0) / (this.x1 - this.x0)) * this.plot.width;
  }

  fromPx(px: number) {
    return this.x0 + ((px - this.plot.left) / this.plot.width) * (this.x1 - this.x0);
  }

  /** Where value `v` of an axis (the left one by default) sits, in points from the top. */
  toPy(v: number, axis: AxisSide = "left") {
    const [y0, y1] = axis === "right" ? [this.y20, this.y21] : [this.y0, this.y1];
    return this.plot.top + this.plot.height - ((v - y0) / (y1 - y0)) * this.plot.height;
  }

  inPlot(px: number, py: number) {
    const p = this.plot;
    return px >= p.left && px <= p.left + p.width && py >= p.top && py <= p.top + p.height;
  }

  // ---- Viewport

  /** Shows [x0, x1]. `remember`: the range before can be gone back to. */
  setXRange(x0: number, x1: number, remember = true) {
    if (!(x1 > x0)) return;
    if (x1 - x0 < MIN_SPAN) {
      const m = (x0 + x1) / 2;
      x0 = m - MIN_SPAN / 2;
      x1 = m + MIN_SPAN / 2;
    }
    if (remember && (x0 !== this.x0 || x1 !== this.x1)) {
      this.history.push({ x0: this.x0, x1: this.x1, follow: this.follow });
      if (this.history.length > 50) this.history.shift();
    }
    this.x0 = x0;
    this.x1 = x1;
    this.follow = false;
    this.yCacheKey = "";
  }

  /** Zooms x by `factor` (above 1 zooms in) around the point `px`. */
  zoomAt(factor: number, px: number) {
    if (!(factor > 0)) return;
    const at = this.fromPx(Math.max(this.plot.left, Math.min(this.plot.left + this.plot.width, px)));
    const x0 = at - (at - this.x0) / factor;
    const x1 = at + (this.x1 - at) / factor;
    this.clampAndSet(x0, x1);
  }

  /** Pans by `dx` points (positive moves the data right, showing earlier times). */
  panBy(dx: number) {
    const dt = (dx / this.plot.width) * (this.x1 - this.x0);
    this.clampAndSet(this.x0 - dt, this.x1 - dt);
  }

  /** Sets a range from a zoom or pan, kept near the data; back at the live edge it follows again. */
  private clampAndSet(x0: number, x1: number) {
    const r = this.dataRange();
    const span = x1 - x0;
    if (r) {
      const full = Math.max(r[1] - r[0], MIN_SPAN);
      if (span > full * 1.02 && this.options.window <= 0) {
        // Zoomed out past everything: show everything, following again.
        this.reset();
        return;
      }
      // Keep some data in view.
      if (x1 < r[0] + span * 0.1) {
        x0 = r[0] + span * 0.1 - span;
        x1 = x0 + span;
      }
      if (x0 > r[1] - span * 0.1) {
        x0 = r[1] - span * 0.1;
        x1 = x0 + span;
      }
    }
    this.setXRange(x0, x1, false);
  }

  /** Back to following the data. */
  reset() {
    this.follow = true;
    this.history = [];
    this.yCacheKey = "";
  }

  /** Back to the range before the last zoom; true when there was one. */
  back(): boolean {
    const prev = this.history.pop();
    if (!prev) {
      if (this.follow) return false;
      this.reset();
      return true;
    }
    this.x0 = prev.x0;
    this.x1 = prev.x1;
    this.follow = prev.follow;
    this.yCacheKey = "";
    return true;
  }

  // ---- Cursor and selection

  /** Puts the cursor at `px` (null: none); true when the sample under it changed. */
  setCursor(px: number | null): boolean {
    this.cursorPx = px;
    const before = this.cursorIndex;
    this.updateCursor();
    return this.cursorIndex !== before;
  }

  /** Puts the cursor at time `x` (a synced chart's cursor), or none. */
  setCursorTime(x: number | null): boolean {
    return this.setCursor(x === null ? null : this.toPx(x));
  }

  private updateCursor() {
    const st = this.store;
    if (this.cursorPx === null || !st || st.length() === 0) {
      this.cursorIndex = -1;
      return;
    }
    const i = st.nearest(this.fromPx(this.cursorPx));
    this.cursorIndex = i;
  }

  /** Steps the cursor `by` samples (the arrow keys), from the right edge when there is none. */
  stepCursor(by: number) {
    const st = this.store;
    if (!st || st.length() === 0) return;
    let i = this.cursorIndex;
    if (i < 0) i = Math.max(0, st.upperBound(this.x1) - 1);
    else i = Math.max(0, Math.min(st.length() - 1, i + by));
    const x = st.x(i);
    if (x < this.x0 || x > this.x1) {
      const span = this.x1 - this.x0;
      this.setXRange(x - span / 2, x + span / 2, false);
    }
    this.cursorPx = this.toPx(x);
    this.cursorIndex = i;
  }

  /** What the cursor is over, or null. */
  cursorInfo(): CursorInfo | null {
    const st = this.store;
    const i = this.cursorIndex;
    if (!st || i < 0 || i >= st.length()) return null;
    return this.infoAt(i);
  }

  /** Each series' value at sample `i` (the last sample with `i` = -1). */
  infoAt(i: number): CursorInfo | null {
    const st = this.store;
    if (!st || st.length() === 0) return null;
    if (i < 0) i = st.length() - 1;
    return {
      index: i,
      time: st.x(i),
      values: this.series.map((s) => {
        const v = s.index < st.seriesCount ? st.y(s.index, i) : NaN;
        // A tenth of the axis's tick step: as precise as the axis, one digit more.
        const step = (s.axis === "right" ? this.y2Step : this.yStep) || undefined;
        return { label: s.label, color: s.color, value: v, text: formatValue(v, s.unit ?? this.unitOf(s.axis), s.unit ? undefined : step && step / 10), show: s.show };
      }),
    };
  }

  /** The cursor's time, written out in full. */
  cursorTimeText(): string {
    const st = this.store;
    if (!st || this.cursorIndex < 0) return "";
    return formatTimeFull(st.x(this.cursorIndex), this.x1 - this.x0, this.options.timeZone);
  }

  beginSelection(px: number) {
    const p = this.clampPx(px);
    this.selection = { from: p, to: p };
  }

  moveSelection(px: number) {
    if (this.selection) this.selection.to = this.clampPx(px);
  }

  /** Zooms to the box; true when it was wide enough to count. */
  endSelection(): boolean {
    const s = this.selection;
    this.selection = null;
    if (!s || Math.abs(s.to - s.from) < 4) return false;
    const a = this.fromPx(Math.min(s.from, s.to));
    const b = this.fromPx(Math.max(s.from, s.to));
    this.setXRange(a, b, true);
    return true;
  }

  private clampPx(px: number) {
    return Math.max(this.plot.left, Math.min(this.plot.left + this.plot.width, px));
  }
}
