/**
 * Columnar time series storage with a min/max pyramid, and the tracer that turns a viewport of it into
 * SVG path data.
 *
 * The pyramid is what lets a chart of ten million points draw in the time of a chart of a few thousand:
 * level L keeps the min and max of each block of 8^L samples, so the min and max of any index range come
 * from at most 2 × 7 entries per level instead of a scan. Tracing a viewport is M4 decimation (first,
 * min, max, last of every pixel column), with the min and max read from the pyramid: its cost follows the
 * plot's width, not the number of points it shows.
 *
 * Everything here is plain TypeScript with no NSH imports, written for QuickJS: typed arrays, no
 * allocation in the hot loops, and `var` locals there (QuickJS checks `let` and `const` on every read).
 */

/** Samples per block at each pyramid level: 8, 64, 512... */
const FAN_BITS = 3;
const FAN = 1 << FAN_BITS;
const MASK = FAN - 1;

/** What every store offers the chart: the TypeScript `TimeSeries` and the Rust one (`native.ts`). */
export interface SeriesStore {
  /** Bumped by every change, so a chart knows when to draw again. */
  readonly version: number;
  /** How many series (y columns) there are. */
  readonly seriesCount: number;
  /** How many samples each series has. */
  length(): number;
  /** The time (x) of sample `i`. */
  x(i: number): number;
  /** The value of series `s` at sample `i` (NaN: none). */
  y(s: number, i: number): number;
  /** The first sample at or after `x` (length when none). */
  lowerBound(x: number): number;
  /** The first sample after `x` (length when none). */
  upperBound(x: number): number;
  /** The sample whose time is nearest `x` (-1 when empty). */
  nearest(x: number): number;
  /** The min and max of series `s` over samples [i0, i1), NaNs skipped: [Infinity, -Infinity] when none. */
  extent(s: number, i0: number, i1: number): [number, number];
  /** Traces series `s` for a viewport as SVG path data (see `TraceOptions`). */
  trace(s: number, o: TraceOptions): string;
  /** Calls `fn` after every change; returns a function that stops it. */
  subscribe(fn: () => void): () => void;
}

/** A viewport and how to trace it. Coordinates are in points, the canvas's. */
export interface TraceOptions {
  /** The time range shown. */
  x0: number;
  x1: number;
  /** The value range shown: y0 at the bottom edge, y1 at the top. */
  y0: number;
  y1: number;
  /** The plot area. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Pixel columns per point (the screen's density). Default 1. */
  density?: number;
  /** A y (in points) to close each run of samples down to, for a filled area. NaN or absent: a line. */
  baseline?: number;
  /** Draw a line straight across a NaN instead of breaking it. Default false. */
  spanGaps?: boolean;
  /** Steps (each value held until the next sample) instead of straight segments. Default false. */
  step?: boolean;
  /**
   * Write coordinates as integers in 1/`scale` points (draw the path under `scale(1 / scale)`): shorter
   * to write and to parse than decimals. Default: points, to 1 decimal.
   */
  scale?: number;
}

/** What `traceInto` reports besides the path. */
export interface TraceStats {
  /** Samples in the viewport (and the one either side). */
  samples: number;
  /** Points emitted into the path. */
  points: number;
  /** Whether it decimated (M4) or drew every sample. */
  decimated: boolean;
}

export interface TimeSeriesOptions {
  /** How many series. Default 1. */
  series?: number;
  /** Samples to make room for at the start. */
  capacity?: number;
  /**
   * Keep at most this many samples: older ones are dropped as new ones come in (a live chart's window).
   * Dropping happens in batches, so the length may run up to an eighth over.
   */
  maxPoints?: number;
}

function grow(a: Float64Array, cap: number): Float64Array {
  const b = new Float64Array(cap);
  b.set(a);
  return b;
}

/** Rounds to 1 decimal: path coordinates in points stay sharp at 2× and 3× and keep the text short. */
function r1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * The TypeScript store. Times must not decrease (samples come in time order, as metrics do); a sample
 * with the same time as the last one is kept.
 */
export class TimeSeries implements SeriesStore {
  readonly seriesCount: number;
  version = 0;
  private n = 0;
  private cap: number;
  private xs: Float64Array;
  private ys: Float64Array[];
  /** mins[s][L - 1], maxs[s][L - 1]: level L's blocks of series s. */
  private mins: Float64Array[][];
  private maxs: Float64Array[][];
  private levels = 0;
  private readonly maxPoints: number;
  private listeners = new Set<() => void>();
  private extentOut: [number, number] = [Infinity, -Infinity];

  constructor(options: TimeSeriesOptions = {}) {
    this.seriesCount = Math.max(1, Math.floor(options.series ?? 1));
    this.maxPoints = options.maxPoints && options.maxPoints > 0 ? Math.floor(options.maxPoints) : Infinity;
    this.cap = Math.max(16, Math.floor(options.capacity ?? 1024));
    this.xs = new Float64Array(this.cap);
    this.ys = [];
    this.mins = [];
    this.maxs = [];
    for (let s = 0; s < this.seriesCount; s++) {
      this.ys.push(new Float64Array(this.cap));
      this.mins.push([]);
      this.maxs.push([]);
    }
  }

  /** A store holding `x` and one array per series. */
  static from(x: ArrayLike<number>, ys: ArrayLike<number>[], options: Omit<TimeSeriesOptions, "series"> = {}) {
    const t = new TimeSeries({ ...options, series: ys.length, capacity: Math.max(options.capacity ?? 0, x.length) });
    t.setData(x, ys);
    return t;
  }

  length() {
    return this.n;
  }

  x(i: number) {
    return this.xs[i];
  }

  y(s: number, i: number) {
    return this.ys[s][i];
  }

  /** The times, a view of the first `length()` (valid until the next change). */
  times(): Float64Array {
    return this.xs.subarray(0, this.n);
  }

  /** Series `s`'s values, a view of the first `length()` (valid until the next change). */
  values(s: number): Float64Array {
    return this.ys[s].subarray(0, this.n);
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private changed() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  private reserve(n: number) {
    if (n <= this.cap) return;
    let cap = this.cap;
    while (cap < n) cap *= 2;
    this.cap = cap;
    this.xs = grow(this.xs, cap);
    for (let s = 0; s < this.seriesCount; s++) this.ys[s] = grow(this.ys[s], cap);
  }

  /** Replaces everything. `ys` holds one array per series, each as long as `x`. */
  setData(x: ArrayLike<number>, ys: ArrayLike<number>[]) {
    const n = x.length;
    this.reserve(n);
    this.xs.set(x as ArrayLike<number>);
    for (let s = 0; s < this.seriesCount; s++) {
      const src = ys[s];
      const dst = this.ys[s];
      if (!src) dst.fill(NaN, 0, n);
      else {
        dst.set(src.length > n ? Array.prototype.slice.call(src, 0, n) : src);
        if (src.length < n) dst.fill(NaN, src.length, n);
      }
    }
    this.n = n;
    this.trim(false);
    this.rebuild(0);
    this.changed();
  }

  /**
   * Adds samples at the end: one (`append(t, [a, b])`) or several (`append([t0, t1], [[a0, a1], [b0, b1]])`).
   * A series without a value gets NaN.
   */
  append(x: number | ArrayLike<number>, ys: ArrayLike<number> | ArrayLike<number>[]) {
    const start = this.n;
    if (typeof x === "number") {
      this.reserve(start + 1);
      this.xs[start] = x;
      const row = ys as ArrayLike<number>;
      for (let s = 0; s < this.seriesCount; s++) {
        const v = row[s];
        this.ys[s][start] = v === undefined || v === null ? NaN : v;
      }
      this.n = start + 1;
    } else {
      const k = x.length;
      if (k === 0) return;
      this.reserve(start + k);
      this.xs.set(x, start);
      const cols = ys as ArrayLike<number>[];
      for (let s = 0; s < this.seriesCount; s++) {
        const src = cols[s];
        if (src) this.ys[s].set(src.length > k ? Array.prototype.slice.call(src, 0, k) : src, start);
        if (!src || src.length < k) this.ys[s].fill(NaN, start + (src ? src.length : 0), start + k);
      }
      this.n = start + k;
    }
    // Fold the new samples in first: trimming shifts the pyramid as it is.
    this.extend(start);
    this.trim(true);
    this.changed();
  }

  /** Drops everything. */
  clear() {
    this.n = 0;
    this.rebuild(0);
    this.changed();
  }

  /** Drops old samples past `maxPoints`; true when the pyramid was rebuilt. */
  private trim(batched: boolean): boolean {
    const over = this.n - this.maxPoints;
    if (over <= 0) return false;
    if (batched && over < Math.max(64, this.maxPoints >> 3)) return false;
    // Drop a whole number of blocks of the biggest level that fits, so levels up to it shift as they are
    // and only those above are worked out again.
    let keep = 0;
    while (keep < this.levels && (FAN << (FAN_BITS * keep)) <= over) keep++;
    const block = 1 << (FAN_BITS * keep);
    const drop = batched ? over - (over % block) : over;
    const n = this.n - drop;
    this.xs.copyWithin(0, drop, this.n);
    for (let s = 0; s < this.seriesCount; s++) this.ys[s].copyWithin(0, drop, this.n);
    this.n = n;
    if (!batched || drop % block !== 0) {
      this.rebuild(0);
      return true;
    }
    for (let s = 0; s < this.seriesCount; s++) {
      for (let L = 1; L <= keep; L++) {
        const shift = drop >>> (FAN_BITS * L);
        const count = this.blocks(L);
        this.mins[s][L - 1].copyWithin(0, shift, shift + count);
        this.maxs[s][L - 1].copyWithin(0, shift, shift + count);
      }
    }
    this.rebuild(keep);
    return true;
  }

  private blocks(L: number) {
    return (this.n + (1 << (FAN_BITS * L)) - 1) >>> (FAN_BITS * L);
  }

  /** Levels a store of `n` samples has: up to the one with a single block. */
  private levelsFor(n: number) {
    let L = 0;
    while (n > 1 << (FAN_BITS * L) && L < 10) L++;
    return L;
  }

  private ensureLevel(s: number, L: number, blocks: number) {
    const mins = this.mins[s];
    const maxs = this.maxs[s];
    if (mins.length < L) {
      mins.push(new Float64Array(Math.max(8, blocks * 2)));
      maxs.push(new Float64Array(Math.max(8, blocks * 2)));
    } else if (mins[L - 1].length < blocks) {
      let cap = mins[L - 1].length;
      while (cap < blocks) cap *= 2;
      mins[L - 1] = grow(mins[L - 1], cap);
      maxs[L - 1] = grow(maxs[L - 1], cap);
    }
  }

  /** Works out every level above `from` again, from the one below. */
  private rebuild(from: number) {
    const levels = this.levelsFor(this.n);
    for (let s = 0; s < this.seriesCount; s++) {
      for (let L = from + 1; L <= levels; L++) {
        const count = this.blocks(L);
        this.ensureLevel(s, L, count);
        const mn = this.mins[s][L - 1];
        const mx = this.maxs[s][L - 1];
        if (L === 1) {
          var y = this.ys[s];
          var n = this.n;
          for (var b = 0; b < count; b++) {
            var lo = Infinity;
            var hi = -Infinity;
            var end = Math.min(n, (b + 1) << FAN_BITS);
            for (var i = b << FAN_BITS; i < end; i++) {
              var v = y[i];
              if (v < lo) lo = v;
              if (v > hi) hi = v;
            }
            mn[b] = lo;
            mx[b] = hi;
          }
        } else {
          var cmn = this.mins[s][L - 2];
          var cmx = this.maxs[s][L - 2];
          var below = this.blocks(L - 1);
          for (var b = 0; b < count; b++) {
            var lo = Infinity;
            var hi = -Infinity;
            var end = Math.min(below, (b + 1) << FAN_BITS);
            for (var i = b << FAN_BITS; i < end; i++) {
              if (cmn[i] < lo) lo = cmn[i];
              if (cmx[i] > hi) hi = cmx[i];
            }
            mn[b] = lo;
            mx[b] = hi;
          }
        }
      }
    }
    this.levels = levels;
  }

  /** Folds samples from `start` on into the pyramid. */
  private extend(start: number) {
    const levels = this.levelsFor(this.n);
    if (levels > this.levels) {
      // A new top level: build it (and only it) from the one below, after updating the others.
      const old = this.levels;
      this.levels = levels;
      this.extendLevels(start, old);
      this.rebuild(old);
      return;
    }
    this.extendLevels(start, levels);
  }

  private extendLevels(start: number, levels: number) {
    var n = this.n;
    for (var s = 0; s < this.seriesCount; s++) {
      var y = this.ys[s];
      for (var L = 1; L <= levels; L++) {
        this.ensureLevel(s, L, this.blocks(L));
        var mn = this.mins[s][L - 1];
        var mx = this.maxs[s][L - 1];
        var shift = FAN_BITS * L;
        var first = start >>> shift;
        // The block `start` falls in may already hold samples: start it from what it has.
        var b = first;
        var lo = (start & ((1 << shift) - 1)) === 0 ? Infinity : mn[b];
        var hi = (start & ((1 << shift) - 1)) === 0 ? -Infinity : mx[b];
        for (var i = start; i < n; i++) {
          var bi = i >>> shift;
          if (bi !== b) {
            mn[b] = lo;
            mx[b] = hi;
            b = bi;
            lo = Infinity;
            hi = -Infinity;
          }
          var v = y[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        mn[b] = lo;
        mx[b] = hi;
      }
    }
  }

  lowerBound(x: number) {
    var xs = this.xs;
    var lo = 0;
    var hi = this.n;
    while (lo < hi) {
      var mid = (lo + hi) >>> 1;
      if (xs[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The first sample after `x` (length when none). */
  upperBound(x: number) {
    var xs = this.xs;
    var lo = 0;
    var hi = this.n;
    while (lo < hi) {
      var mid = (lo + hi) >>> 1;
      if (xs[mid] <= x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The sample whose time is nearest `x` (-1 when empty). */
  nearest(x: number) {
    const n = this.n;
    if (n === 0) return -1;
    const i = this.lowerBound(x);
    if (i <= 0) return 0;
    if (i >= n) return n - 1;
    return x - this.xs[i - 1] <= this.xs[i] - x ? i - 1 : i;
  }

  extent(s: number, i0: number, i1: number): [number, number] {
    this.rangeMinMax(s, Math.max(0, i0), Math.min(this.n, i1));
    return [this.extentOut[0], this.extentOut[1]];
  }

  /** The min and max of series s over [a, b) into `extentOut`, from the pyramid. */
  private rangeMinMax(s: number, a: number, b: number) {
    var lo = Infinity;
    var hi = -Infinity;
    var y = this.ys[s];
    var mins = this.mins[s];
    var maxs = this.maxs[s];
    var top = this.levels;
    var L = 0;
    while (a < b) {
      if (L < top && b - a >= FAN * 2) {
        // Take the ragged ends at this level, then go up one.
        if (L === 0) {
          while ((a & MASK) !== 0) {
            var v = y[a++];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
          while ((b & MASK) !== 0) {
            var v = y[--b];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        } else {
          var mn = mins[L - 1];
          var mx = maxs[L - 1];
          while ((a & MASK) !== 0) {
            if (mn[a] < lo) lo = mn[a];
            if (mx[a] > hi) hi = mx[a];
            a++;
          }
          while ((b & MASK) !== 0) {
            b--;
            if (mn[b] < lo) lo = mn[b];
            if (mx[b] > hi) hi = mx[b];
          }
        }
        a >>>= FAN_BITS;
        b >>>= FAN_BITS;
        L++;
      } else {
        if (L === 0) {
          for (; a < b; a++) {
            var v = y[a];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        } else {
          var mn = mins[L - 1];
          var mx = maxs[L - 1];
          for (; a < b; a++) {
            if (mn[a] < lo) lo = mn[a];
            if (mx[a] > hi) hi = mx[a];
          }
        }
      }
    }
    this.extentOut[0] = lo;
    this.extentOut[1] = hi;
  }

  /** The stats of the last `trace`. */
  readonly stats: TraceStats = { samples: 0, points: 0, decimated: false };

  trace(s: number, o: TraceOptions): string {
    var n = this.n;
    var stats = this.stats;
    stats.samples = 0;
    stats.points = 0;
    stats.decimated = false;
    if (n === 0 || !(o.x1 > o.x0) || !(o.width > 0) || !(o.height > 0)) return "";
    var xs = this.xs;
    var y = this.ys[s];
    var x0 = o.x0;
    var left = o.left;
    // Coordinates come out as integers in 1/scale points, or in points to 1 decimal.
    var S = o.scale !== undefined && o.scale > 0 ? o.scale : 0;
    var rr = S > 0 ? (v: number) => Math.round(v * S) : r1;
    var kx = o.width / (o.x1 - o.x0);
    var ky = o.y1 === o.y0 ? 0 : o.height / (o.y1 - o.y0);
    var bottom = o.top + o.height;
    var yb = o.y0;
    var midY = rr(o.top + o.height / 2);
    var baseline = o.baseline !== undefined && o.baseline === o.baseline ? rr(o.baseline) : NaN;
    var fill = baseline === baseline;
    var spanGaps = !!o.spanGaps;
    var step = !!o.step;
    // One sample either side, so the line runs to the edges.
    var i0 = this.lowerBound(o.x0);
    if (i0 > 0) i0--;
    var i1 = this.upperBound(o.x1);
    if (i1 < n) i1++;
    stats.samples = i1 - i0;
    var cols = Math.max(1, Math.ceil(o.width * (o.density ?? 1)));
    var d = "";
    var points = 0;
    // The run being drawn: whether it has begun, and its first x (to close a fill).
    var open = false;
    var runX = 0;
    if (i1 - i0 <= cols * 2) {
      // Few enough to draw every sample.
      for (var i = i0; i < i1; i++) {
        var v = y[i];
        if (v !== v) {
          if (!spanGaps && open) {
            if (fill) d += "V" + baseline + "H" + runX + "Z";
            open = false;
          }
          continue;
        }
        var px = rr(left + (xs[i] - x0) * kx);
        var py = ky === 0 ? midY : rr(bottom - (v - yb) * ky);
        if (!open) {
          if (fill) d += "M" + px + " " + baseline + "V" + py;
          else d += "M" + px + " " + py;
          open = true;
          runX = px;
        } else if (step) d += "H" + px + "V" + py;
        else d += "L" + px + " " + py;
        points++;
      }
    } else {
      stats.decimated = true;
      // M4: for each pixel column, the first, min, max and last sample, as one vertical stroke.
      var colW = (o.x1 - o.x0) / cols;
      var pxW = o.width / cols;
      var a = i0;
      var mins = this.mins[s];
      var maxs = this.maxs[s];
      var top = this.levels;
      if (xs[a] < x0 && y[a] === y[a]) {
        // The sample left of the view: a point of its own, so the line comes in from the edge.
        var px = rr(left + (xs[a] - x0) * kx);
        var py = ky === 0 ? midY : rr(bottom - (y[a] - yb) * ky);
        d += fill ? "M" + px + " " + baseline + "V" + py : "M" + px + " " + py;
        open = true;
        runX = px;
        points++;
        a++;
      } else if (xs[a] < x0) a++;
      var c0 = Math.max(0, Math.floor((xs[a] - x0) / colW));
      for (var c = c0; c <= cols && a < i1; c++) {
        // The samples in column c: [a, b).
        var edge = x0 + (c + 1) * colW;
        var b: number;
        if (c === cols) b = i1;
        else {
          // Gallop from where an even spread of the samples left would put the edge, then bisect: a
          // few reads a column instead of a full binary search.
          var lo2 = a;
          var hi2 = i1;
          var guess = a + Math.floor((i1 - a) / (cols - c + 1));
          if (guess >= i1) guess = i1 - 1;
          var stride = 1;
          if (xs[guess] < edge) {
            lo2 = guess + 1;
            hi2 = lo2;
            while (hi2 < i1 && xs[hi2] < edge) {
              lo2 = hi2 + 1;
              hi2 += stride;
              stride *= 2;
            }
            if (hi2 > i1) hi2 = i1;
          } else {
            hi2 = guess;
            lo2 = guess - 1;
            while (lo2 > a && xs[lo2] >= edge) {
              hi2 = lo2;
              lo2 -= stride;
              stride *= 2;
            }
            if (lo2 < a) lo2 = a;
          }
          while (lo2 < hi2) {
            var mid = (lo2 + hi2) >>> 1;
            if (xs[mid] < edge) lo2 = mid + 1;
            else hi2 = mid;
          }
          b = lo2;
        }
        if (b === a) continue;
        var px = c === cols ? rr(left + (xs[b - 1] - x0) * kx) : rr(left + (c + 0.5) * pxW);
        var first = y[a];
        var last = y[b - 1];
        var lo: number;
        var hi: number;
        if (b - a === 1) {
          lo = first;
          hi = first;
        } else {
          // rangeMinMax, inlined.
          var ra = a;
          var rb = b;
          lo = Infinity;
          hi = -Infinity;
          var L = 0;
          while (ra < rb) {
            if (L < top && rb - ra >= FAN * 2) {
              if (L === 0) {
                while ((ra & MASK) !== 0) {
                  var v = y[ra++];
                  if (v < lo) lo = v;
                  if (v > hi) hi = v;
                }
                while ((rb & MASK) !== 0) {
                  var v = y[--rb];
                  if (v < lo) lo = v;
                  if (v > hi) hi = v;
                }
              } else {
                var mn = mins[L - 1];
                var mx = maxs[L - 1];
                while ((ra & MASK) !== 0) {
                  if (mn[ra] < lo) lo = mn[ra];
                  if (mx[ra] > hi) hi = mx[ra];
                  ra++;
                }
                while ((rb & MASK) !== 0) {
                  rb--;
                  if (mn[rb] < lo) lo = mn[rb];
                  if (mx[rb] > hi) hi = mx[rb];
                }
              }
              ra >>>= FAN_BITS;
              rb >>>= FAN_BITS;
              L++;
            } else if (L === 0) {
              for (; ra < rb; ra++) {
                var v = y[ra];
                if (v < lo) lo = v;
                if (v > hi) hi = v;
              }
            } else {
              var mn = mins[L - 1];
              var mx = maxs[L - 1];
              for (; ra < rb; ra++) {
                if (mn[ra] < lo) lo = mn[ra];
                if (mx[ra] > hi) hi = mx[ra];
              }
            }
          }
        }
        a = b;
        if (lo > hi) {
          // Only NaNs in this column: a gap.
          if (!spanGaps && open) {
            if (fill) d += "V" + baseline + "H" + runX + "Z";
            open = false;
          }
          continue;
        }
        var pFirst = first === first ? first : lo;
        var pLast = last === last ? last : hi;
        var yFirst = ky === 0 ? midY : rr(bottom - (pFirst - yb) * ky);
        var yLo = ky === 0 ? midY : rr(bottom - (lo - yb) * ky);
        var yHi = ky === 0 ? midY : rr(bottom - (hi - yb) * ky);
        var yLast = ky === 0 ? midY : rr(bottom - (pLast - yb) * ky);
        if (!open) {
          if (fill) d += "M" + px + " " + baseline + "V" + yFirst;
          else d += "M" + px + " " + yFirst;
          open = true;
          runX = px;
        } else if (step) d += "H" + px + "V" + yFirst;
        else d += "L" + px + " " + yFirst;
        points++;
        // The column's stroke: down to the min and up to the max (in either order it covers them), then
        // to where the next column starts from. Points that would repeat are left out.
        if (yLo !== yHi) {
          if (yFirst !== yLo) d += "V" + yLo;
          d += "V" + yHi;
          if (yLast !== yHi) d += "V" + yLast;
          points += 2;
        } else if (yLast !== yFirst) {
          d += "V" + yLast;
          points++;
        }
      }
    }
    if (open && fill) d += "V" + baseline + "H" + runX + "Z";
    stats.points = points;
    return d;
  }
}
