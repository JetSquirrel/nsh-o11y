/**
 * Log lines, kept in time order, with what a log view asks of them: the lines a filter lets through
 * (levels, text, a time range), how many of each level there are, and a histogram of volume over time.
 * Plain TypeScript, no NSH imports.
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/** Every level, least severe first. */
export const LOG_LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"];

/** Level colors, the series palette's hues: errors red, warnings yellow, info aqua, debug blue. */
export const LOG_LEVEL_COLORS: Record<LogLevel, string> = {
  trace: "#8a8f98",
  debug: "#2a78d6",
  info: "#1baf7a",
  warn: "#eda100",
  error: "#e34948",
  fatal: "#b02a7a",
};

export interface LogEntry {
  /** Milliseconds. */
  time: number;
  level: LogLevel;
  message: string;
  service?: string;
  /** Links the line to a trace (and a span in it). */
  traceId?: string;
  spanId?: string;
  attributes?: Record<string, string | number | boolean>;
}

export interface LogFilter {
  /** The levels shown (default all). */
  levels?: readonly LogLevel[];
  /** Lines whose message, service or attributes contain it, case-insensitive. */
  text?: string;
  /** Only lines in [from, to]. */
  from?: number;
  to?: number;
}

/** Volume over time: `counts[level][bucket]` lines in each bucket of `step` ms from `t0`. */
export interface LogHistogram {
  t0: number;
  step: number;
  buckets: number;
  counts: Record<LogLevel, Float64Array>;
  /** The largest stacked bucket. */
  max: number;
}

export interface LogStoreOptions {
  /** Keep at most this many lines, dropping the oldest. Default unlimited. */
  maxEntries?: number;
}

const LEVEL_INDEX: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 };

function levelOf(l: string | undefined): LogLevel {
  return l && l in LEVEL_INDEX ? (l as LogLevel) : "info";
}

export class LogStore {
  private entries: LogEntry[] = [];
  /** Lower-cased search text per line, made when a text filter first needs it. */
  private search: (string | undefined)[] = [];
  private listeners = new Set<() => void>();
  /** Per level, how many lines of it come before each index: counts over a range are two lookups. */
  private cum: Int32Array[] = [];
  private cumLen = 0;
  readonly maxEntries: number;
  /** Bumped on every change. */
  version = 0;
  /**
   * Bumped when lines move: inserted out of order, dropped, replaced or cleared. While it holds, the
   * lines so far keep their indices and new ones only go at the end, so what was computed over them
   * still stands and only the new lines need looking at.
   */
  epoch = 0;

  constructor(options: LogStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? Infinity;
  }

  static from(entries: LogEntry[], options?: LogStoreOptions) {
    const s = new LogStore(options);
    s.setEntries(entries);
    return s;
  }

  length() {
    return this.entries.length;
  }

  get(i: number): LogEntry {
    return this.entries[i];
  }

  /** The first and last times, or null when empty. */
  extent(): [number, number] | null {
    const n = this.entries.length;
    return n ? [this.entries[0].time, this.entries[n - 1].time] : null;
  }

  /** Adds lines. They may come a little out of order: each goes where its time puts it. */
  append(entry: LogEntry | readonly LogEntry[]) {
    const list = Array.isArray(entry) ? (entry as readonly LogEntry[]) : [entry as LogEntry];
    for (const e of list) {
      const n = this.entries.length;
      if (!n || e.time >= this.entries[n - 1].time) {
        this.entries.push(e);
        this.search.push(undefined);
      } else {
        const i = this.upper(e.time);
        this.entries.splice(i, 0, e);
        this.search.splice(i, 0, undefined);
        this.moved();
      }
    }
    // Drop the oldest in batches (a tenth over the limit) so a live stream doesn't splice every line.
    if (this.entries.length > this.maxEntries * 1.1 || (this.maxEntries < 100 && this.entries.length > this.maxEntries)) {
      const k = this.entries.length - this.maxEntries;
      this.entries.splice(0, k);
      this.search.splice(0, k);
      this.moved();
    }
    this.changed();
  }

  setEntries(entries: readonly LogEntry[]) {
    this.entries = entries.slice().sort((a, b) => a.time - b.time);
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
    this.search = new Array(this.entries.length);
    this.moved();
    this.changed();
  }

  clear() {
    this.entries = [];
    this.search = [];
    this.moved();
    this.changed();
  }

  /** Lines moved: what was computed over them by index starts over. */
  private moved() {
    this.epoch++;
    this.queries.clear();
    this.cumLen = 0;
  }

  /** Brings the per-level running counts up to the last line. */
  private counts(): Int32Array[] {
    const n = this.entries.length;
    if (this.cum.length === 0 || this.cum[0].length < n + 1) {
      // Grow by doubling, keeping what is counted.
      const cap = Math.max(1024, (n + 1) * 2);
      this.cum = LOG_LEVELS.map((_, l) => {
        const a = new Int32Array(cap);
        if (this.cum[l]) a.set(this.cum[l].subarray(0, this.cumLen + 1));
        return a;
      });
    }
    const c = this.cum;
    for (let i = this.cumLen; i < n; i++) {
      const li = LEVEL_INDEX[levelOf(this.entries[i].level)];
      for (let l = 0; l < 6; l++) c[l][i + 1] = c[l][i] + (l === li ? 1 : 0);
    }
    this.cumLen = n;
    return c;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  /** The first index whose time is >= t. */
  lower(t: number) {
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.entries[m].time < t) lo = m + 1;
      else hi = m;
    }
    return lo;
  }

  /** The first index whose time is > t. */
  upper(t: number) {
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.entries[m].time <= t) lo = m + 1;
      else hi = m;
    }
    return lo;
  }

  private text(i: number): string {
    let s = this.search[i];
    if (s === undefined) {
      const e = this.entries[i];
      s = e.message;
      if (e.service) s += "\u0000" + e.service;
      if (e.attributes) for (const k in e.attributes) s += "\u0000" + k + "=" + String(e.attributes[k]);
      s = s.toLowerCase();
      this.search[i] = s;
    }
    return s;
  }

  /** Whether line `i` passes the filter's levels and text (not its range). */
  private passes(i: number, levels: boolean[] | null, needle: string) {
    if (levels && !levels[LEVEL_INDEX[levelOf(this.entries[i].level)]]) return false;
    return !needle || this.text(i).indexOf(needle) >= 0;
  }

  private bounds(f: LogFilter): [number, number] {
    return [f.from !== undefined ? this.lower(f.from) : 0, f.to !== undefined ? this.upper(f.to) : this.entries.length];
  }

  private static levelMask(f: LogFilter): boolean[] | null {
    if (!f.levels) return null;
    const m = [false, false, false, false, false, false];
    for (const l of f.levels) m[LEVEL_INDEX[l]] = true;
    return m;
  }

  /**
   * The indices of the lines the filter lets through, oldest first. The answers to the last few filters
   * are kept; while only appends happen, a kept answer is extended by looking at the new lines alone.
   * The array returned is never changed afterwards.
   */
  query(f: LogFilter = {}): number[] {
    const key = `${f.levels ? f.levels.join(",") : "*"}|${f.text ?? ""}|${f.from ?? ""}|${f.to ?? ""}`;
    const [a, b] = this.bounds(f);
    const levels = LogStore.levelMask(f);
    const needle = (f.text ?? "").trim().toLowerCase();
    const hit = this.queries.get(key);
    let from = a;
    let base: number[] | null = null;
    if (hit && hit.epoch === this.epoch) {
      if (hit.scanned >= this.entries.length) return hit.result;
      from = Math.max(a, hit.scanned);
      base = hit.result;
    }
    const out: number[] = [];
    if (!levels && !needle) for (let i = from; i < b; i++) out.push(i);
    else for (let i = from; i < b; i++) if (this.passes(i, levels, needle)) out.push(i);
    const result = base ? (out.length ? base.concat(out) : base) : out;
    this.queries.delete(key);
    this.queries.set(key, { epoch: this.epoch, scanned: this.entries.length, result });
    // The view asks a few filters a frame (the list, the toggles' counts, the histogram): keep four.
    if (this.queries.size > 4) this.queries.delete(this.queries.keys().next().value!);
    return result;
  }

  private queries = new Map<string, { epoch: number; scanned: number; result: number[] }>();

  /** How many lines of each level pass the filter's text and range (its levels ignored: the counts on the level toggles). */
  levelCounts(f: LogFilter = {}): Record<LogLevel, number> {
    const counts = [0, 0, 0, 0, 0, 0];
    const needle = (f.text ?? "").trim();
    if (!needle) {
      // Two lookups per level in the running counts, whatever the number of lines.
      const [a, b] = this.bounds(f);
      const c = this.counts();
      for (let l = 0; l < 6; l++) counts[l] = c[l][b] - c[l][a];
    } else for (const i of this.query({ text: needle, from: f.from, to: f.to })) counts[LEVEL_INDEX[levelOf(this.entries[i].level)]]++;
    return { trace: counts[0], debug: counts[1], info: counts[2], warn: counts[3], error: counts[4], fatal: counts[5] };
  }

  /**
   * Volume over [t0, t1] in buckets `step` ms wide, aligned to the step (`timeStep` picks a
   * calendar-friendly one), of the lines passing the filter's levels and text (not its range).
   */
  histogram(t0: number, t1: number, step: number, f: LogFilter = {}): LogHistogram {
    const start = Math.floor(t0 / step) * step;
    const buckets = Math.max(1, Math.ceil((t1 - start) / step) + (t1 === start ? 1 : 0));
    const counts = {} as Record<LogLevel, Float64Array>;
    for (const l of LOG_LEVELS) counts[l] = new Float64Array(buckets);
    const levels = LogStore.levelMask(f);
    const needle = (f.text ?? "").trim().toLowerCase();
    const end = this.upper(t1);
    if (!needle) {
      // Each bucket's counts are differences of the running counts at its edges: a binary search per
      // edge, so a frame costs the same at a thousand lines as at a million.
      const c = this.counts();
      let lo = this.lower(start);
      for (let k = 0; k < buckets; k++) {
        const hi = Math.min(end, this.lower(start + (k + 1) * step));
        for (let l = 0; l < 6; l++) if (!levels || levels[l]) counts[LOG_LEVELS[l]][k] = c[l][hi] - c[l][lo];
        lo = hi;
      }
    } else {
      // Searching: walk the matching lines in view (the match list is kept and extended).
      const m = this.query({ levels: f.levels, text: f.text });
      let i = 0;
      let hi = m.length;
      while (i < hi) {
        const mid = (i + hi) >> 1;
        if (this.entries[m[mid]].time < start) i = mid + 1;
        else hi = mid;
      }
      for (; i < m.length && m[i] < end; i++) {
        const e = this.entries[m[i]];
        const k = Math.floor((e.time - start) / step);
        if (k >= 0 && k < buckets) counts[levelOf(e.level)][k]++;
      }
    }
    let max = 0;
    for (let k = 0; k < buckets; k++) {
      let s = 0;
      for (const l of LOG_LEVELS) s += counts[l][k];
      if (s > max) max = s;
    }
    return { t0: start, step, buckets, counts, max };
  }
}
