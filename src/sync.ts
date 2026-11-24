/**
 * Links charts on a dashboard: they share the cursor (one crosshair across every panel, at the same time)
 * and, optionally, the zoom.
 */
import { signal, type Accessor } from "nsh";

export interface ChartSyncOptions {
  /** Zooming one chart zooms the others to the same range. Default true. */
  zoom?: boolean;
}

export class ChartSync {
  readonly zoom: boolean;
  private readonly cursorSignal = signal<{ time: number | null; from: number }>({ time: null, from: 0 });
  private readonly rangeSignal = signal<{ range: [number, number] | null; from: number }>({ range: null, from: 0 });
  private nextId = 1;

  constructor(options: ChartSyncOptions = {}) {
    this.zoom = options.zoom ?? true;
  }

  /** The cursor's time across the linked charts (null: none). */
  readonly cursor: Accessor<number | null> = () => this.cursorSignal().time;
  /** The range the linked charts are zoomed to (null: following their data). */
  readonly range: Accessor<[number, number] | null> = () => this.rangeSignal().range;

  /** @internal An id for a chart, so it can tell its own changes from the others'. */
  _join(): number {
    return this.nextId++;
  }

  /** @internal */
  _cursor() {
    return this.cursorSignal();
  }

  /** @internal */
  _range() {
    return this.rangeSignal();
  }

  /** @internal */
  _setCursor(time: number | null, from: number) {
    const c = this.cursorSignal();
    if (c.time === time && c.from === from) return;
    this.cursorSignal.set({ time, from });
  }

  /** @internal */
  _setRange(range: [number, number] | null, from: number) {
    if (!this.zoom) return;
    this.rangeSignal.set({ range, from });
  }

  /** Puts every linked chart back to following its data. */
  reset() {
    this.rangeSignal.set({ range: null, from: 0 });
  }
}

/** A link for charts that should share their cursor and zoom: pass it as `sync` to each. */
export function createChartSync(options?: ChartSyncOptions) {
  return new ChartSync(options);
}
