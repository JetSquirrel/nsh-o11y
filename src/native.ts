/**
 * The optional Rust backend (`native/`, imported as `nsh-o11y/native`). An app that adds the nsh-o11y
 * nshm registers it once; from then on `createTimeSeries` keeps samples in Rust:
 *
 * ```ts
 * import * as native from "nsh-o11y/native";
 * import { setNativeBackend } from "nsh-o11y";
 * setNativeBackend(native);
 * ```
 *
 * Without it nothing changes: the TypeScript store runs. nsh-o11y never imports the crate itself, so apps
 * without Rust (and pure-TS hosts such as the tests) keep working.
 */
import { TimeSeries, type SeriesStore, type TimeSeriesOptions, type TraceOptions, type TraceStats } from "./store";

/** What `nsh-o11y/native`'s `SeriesBuffer` offers (see `native/src/lib.rs`). */
export interface NativeSeriesBuffer {
  seriesCount(): number;
  length(): number;
  setData(x: Uint8Array, ys: Uint8Array): void;
  append(x: Uint8Array, ys: Uint8Array): void;
  appendRow(x: number, ys: number[]): void;
  clear(): void;
  x(i: number): number;
  y(s: number, i: number): number;
  row(i: number): number[];
  lowerBound(x: number): number;
  upperBound(x: number): number;
  nearest(x: number): number;
  extent(s: number, i0: number, i1: number): number[];
  trace(s: number, o: number[]): string;
  stats(): number[];
}

/** The module `nsh-o11y/native` exports. */
export interface NativeBackend {
  SeriesBuffer: new (series: number, maxPoints: number) => NativeSeriesBuffer;
}

let backend: NativeBackend | null = null;

/** Uses the Rust backend for the stores made from now on (null goes back to TypeScript). */
export function setNativeBackend(native: NativeBackend | null) {
  backend = native;
}

/** The registered backend, or null. */
export function nativeBackend(): NativeBackend | null {
  return backend;
}

/** The writing side every store from `createTimeSeries` has, on top of what charts read. */
export interface WritableSeriesStore extends SeriesStore {
  /** One sample (`append(t, [a, b])`) or several (`append([t0, t1], [[a0, a1], [b0, b1]])`). */
  append(x: number | ArrayLike<number>, ys: ArrayLike<number> | ArrayLike<number>[]): void;
  /** Replaces everything. */
  setData(x: ArrayLike<number>, ys: ArrayLike<number>[]): void;
  clear(): void;
  /** Where the samples live. */
  readonly backend: "ts" | "rust";
  readonly stats: TraceStats;
}

function bytes(values: ArrayLike<number>, into?: Float64Array): Uint8Array {
  const f = into ?? new Float64Array(values.length);
  if (!into) f.set(values as ArrayLike<number>);
  return new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
}

/** Series one after another, `k` values each, as f64 bytes. */
function packColumns(ys: ArrayLike<number>[], series: number, k: number): Uint8Array {
  const f = new Float64Array(series * k);
  f.fill(NaN);
  for (let s = 0; s < series; s++) {
    const col = ys[s];
    if (!col) continue;
    const m = Math.min(k, col.length);
    if (m === col.length) f.set(col as ArrayLike<number>, s * k);
    else for (let i = 0; i < m; i++) f[s * k + i] = col[i];
  }
  return bytes(f, f);
}

/** A store whose samples live in Rust. */
export class NativeTimeSeries implements WritableSeriesStore {
  readonly backend = "rust" as const;
  readonly seriesCount: number;
  readonly stats: TraceStats = { samples: 0, points: 0, decimated: false };
  version = 0;
  private buf: NativeSeriesBuffer;
  private listeners = new Set<() => void>();
  private n = 0;
  private opts = new Array<number>(13);

  constructor(native: NativeBackend, options: TimeSeriesOptions = {}) {
    this.seriesCount = Math.max(1, Math.floor(options.series ?? 1));
    this.buf = new native.SeriesBuffer(this.seriesCount, options.maxPoints ?? 0);
  }

  private changed() {
    this.n = this.buf.length();
    this.version++;
    for (const fn of this.listeners) fn();
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  setData(x: ArrayLike<number>, ys: ArrayLike<number>[]) {
    this.buf.setData(bytes(x), packColumns(ys, this.seriesCount, x.length));
    this.changed();
  }

  append(x: number | ArrayLike<number>, ys: ArrayLike<number> | ArrayLike<number>[]) {
    if (typeof x === "number") {
      const row = ys as ArrayLike<number>;
      const vals = new Array<number>(this.seriesCount);
      for (let s = 0; s < this.seriesCount; s++) {
        const v = row[s];
        vals[s] = v === undefined || v === null ? NaN : v;
      }
      this.buf.appendRow(x, vals);
    } else {
      if (x.length === 0) return;
      this.buf.append(bytes(x), packColumns(ys as ArrayLike<number>[], this.seriesCount, x.length));
    }
    this.changed();
  }

  clear() {
    this.buf.clear();
    this.changed();
  }

  length() {
    return this.n;
  }

  x(i: number) {
    return this.buf.x(i);
  }

  y(s: number, i: number) {
    return this.buf.y(s, i);
  }

  lowerBound(x: number) {
    return this.buf.lowerBound(x);
  }

  upperBound(x: number) {
    return this.buf.upperBound(x);
  }

  nearest(x: number) {
    return this.buf.nearest(x);
  }

  extent(s: number, i0: number, i1: number): [number, number] {
    const e = this.buf.extent(s, i0, i1);
    return [e[0], e[1]];
  }

  trace(s: number, o: TraceOptions): string {
    const a = this.opts;
    a[0] = o.x0;
    a[1] = o.x1;
    a[2] = o.y0;
    a[3] = o.y1;
    a[4] = o.left;
    a[5] = o.top;
    a[6] = o.width;
    a[7] = o.height;
    a[8] = o.density ?? 1;
    a[9] = o.baseline ?? NaN;
    a[10] = o.spanGaps ? 1 : 0;
    a[11] = o.step ? 1 : 0;
    a[12] = o.scale ?? 0;
    const d = this.buf.trace(s, a);
    const st = this.buf.stats();
    this.stats.samples = st[0];
    this.stats.points = st[1];
    this.stats.decimated = st[2] !== 0;
    return d;
  }
}

class TsStore extends TimeSeries implements WritableSeriesStore {
  readonly backend = "ts" as const;
}

/**
 * A store for a chart's samples: in Rust when the backend is registered (`setNativeBackend`), else in
 * TypeScript. Pass `backend` to choose.
 */
export function createTimeSeries(options: TimeSeriesOptions & { backend?: "auto" | "ts" | "rust" } = {}): WritableSeriesStore {
  const want = options.backend ?? "auto";
  if (want !== "ts" && backend) return new NativeTimeSeries(backend, options);
  if (want === "rust") throw new Error("nsh-o11y: no Rust backend registered (setNativeBackend)");
  return new TsStore(options);
}
