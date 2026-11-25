/**
 * An imperative handle on a mounted `TimeSeriesChart`: zoom, reset, go back, read the range and the
 * cursor, export an image. Its reactive members are signals, so JSX that reads them follows the chart.
 */
import { OffscreenCanvas, Path2D, signal, type Accessor } from "nsh";
import type { ChartEngine } from "./chart";
import { renderOverlay, renderPlot, type Ctx2D } from "./render";
import type { ChartTheme, CursorInfo } from "./types";

export interface ToImageOptions {
  /** Size in points; the chart's own by default. */
  width?: number;
  height?: number;
  /** Pixel density of the image. Default 2. */
  scale?: number;
  /** Fill behind the chart; the theme's background when unset. */
  background?: string;
}

export class ChartController {
  private engine: ChartEngine | null = null;
  private wake: () => void = () => {};
  private theme: () => ChartTheme | null = () => null;

  private readonly rangeSignal = signal<[number, number]>([0, 1], { equals: (a, b) => a[0] === b[0] && a[1] === b[1] });
  private readonly followSignal = signal(true);
  private readonly cursorSignal = signal<CursorInfo | null>(null);

  /** The x (time) range shown. */
  readonly range: Accessor<[number, number]> = () => this.rangeSignal();
  /** Whether the chart follows its data (live), rather than a range the user zoomed to. */
  readonly following: Accessor<boolean> = () => this.followSignal();
  /** What the cursor is over, or null. */
  readonly cursor: Accessor<CursorInfo | null> = () => this.cursorSignal();

  /** @internal */
  _attach(engine: ChartEngine, wake: () => void, theme: () => ChartTheme | null) {
    this.engine = engine;
    this.wake = wake;
    this.theme = theme;
  }

  /** @internal */
  _detach(engine: ChartEngine) {
    if (this.engine !== engine) return;
    this.engine = null;
    this.wake = () => {};
  }

  /** @internal */
  _report(state: { range?: [number, number]; follow?: boolean; cursor?: CursorInfo | null }) {
    if (state.range) this.rangeSignal.set(state.range);
    if (state.follow !== undefined) this.followSignal.set(state.follow);
    if (state.cursor !== undefined) this.cursorSignal.set(state.cursor);
  }

  private act(fn: (e: ChartEngine) => void) {
    if (!this.engine) return;
    fn(this.engine);
    this.wake();
  }

  /** Shows [x0, x1] (times in ms). */
  setRange(x0: number, x1: number) {
    this.act((e) => e.setXRange(x0, x1, true));
  }

  /** Zooms in (factor above 1) or out around the middle. */
  zoom(factor: number) {
    this.act((e) => e.zoomAt(factor, e.plot.left + e.plot.width / 2));
  }

  /** Back to following the data. */
  reset() {
    this.act((e) => e.reset());
  }

  /** Back to the range before the last zoom. */
  back() {
    this.act((e) => e.back());
  }

  /** Shows or hides series `index`. */
  toggleSeries(index: number) {
    this.act((e) => e.toggle(index));
  }

  /** Renders the chart to an image (a PNG `Blob`). */
  async toImage(options: ToImageOptions = {}): Promise<Blob> {
    const engine = this.engine;
    const theme = this.theme();
    if (!engine || !theme) throw new Error("nsh-o11y: the chart is not mounted");
    const w = options.width ?? engine.width;
    const h = options.height ?? engine.height;
    const canvas = new OffscreenCanvas(w, h);
    const cx = canvas.getContext("2d") as unknown as Ctx2D;
    const ow = engine.width;
    const oh = engine.height;
    engine.setSize(w, h);
    engine.update();
    const t = { ...theme, background: options.background ?? theme.background ?? null };
    const scale = options.scale ?? 2;
    renderPlot(cx, engine, t, (d) => new Path2D(d), scale);
    renderOverlay(cx, engine, t);
    engine.setSize(ow, oh);
    engine.update();
    return canvas.convertToBlob({ scale });
  }
}

export function createChartController() {
  return new ChartController();
}
