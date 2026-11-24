import type { Unit, TimeZone } from "./scale";

/** How one series (one y column of the store) is drawn. */
export interface SeriesOptions {
  /** What the legend and the readout call it. */
  label: string;
  /** Its color; the palette's next one when unset. */
  color?: string;
  /** Line width in points. Default 1.5. */
  width?: number;
  /** Fill under the line, at this opacity (0 to 1); `true` is 0.12. Default none. */
  fill?: number | boolean;
  /** A dash pattern, as `setLineDash` takes it. */
  dash?: number[];
  /** Hold each value until the next sample (counters, states). Default false. */
  step?: boolean;
  /** Draw straight across missing values (NaN) instead of leaving a gap. Default false. */
  spanGaps?: boolean;
  /** Shown at first. Default true; the legend toggles it. */
  show?: boolean;
  /** Its own unit in the readout; the chart's otherwise. */
  unit?: Unit;
}

/** A horizontal line across the plot: an SLO, an alert threshold. */
export interface Threshold {
  value: number;
  color?: string;
  label?: string;
  /** Default [4, 4]. `[]` is solid. */
  dash?: number[];
}

/** A moment or a span of time marked on the plot: a deploy, an incident, an alert firing. */
export interface Annotation {
  time: number;
  /** For a span: where it ends. */
  end?: number;
  label?: string;
  color?: string;
}

export interface ChartColors {
  /** Fill behind the plot. Default transparent. */
  background?: string;
  text?: string;
  /** Axis labels. */
  muted?: string;
  grid?: string;
  /** The crosshair. */
  cursor?: string;
  /** The drag-to-zoom box. */
  selection?: string;
  /** Series colors in order. */
  palette?: readonly string[];
}

/** Colors the renderer draws with, resolved from the theme and `ChartColors`. */
export interface ChartTheme {
  background: string | null;
  text: string;
  muted: string;
  grid: string;
  cursor: string;
  selection: string;
  /** What the dots at the cursor are ringed with: the surface they sit on. */
  surface: string;
  palette: readonly string[];
  fontFamily: string;
  fontSize: number;
}

/** A series resolved for drawing. */
export interface ResolvedSeries {
  index: number;
  label: string;
  color: string;
  width: number;
  fill: number;
  dash: number[] | null;
  step: boolean;
  spanGaps: boolean;
  show: boolean;
  unit: Unit | undefined;
}

/** What the cursor is over: the sample nearest it and each series' value there. */
export interface CursorInfo {
  index: number;
  time: number;
  values: { label: string; color: string; value: number; text: string; show: boolean }[];
}

export type { Unit, TimeZone };
