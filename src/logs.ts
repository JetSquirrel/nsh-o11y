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
  private cache: { key: string; version: number; result: number[] } | null = null;
  readonly maxEntries: number;
  /** Bumped on every change. */
  version = 0;

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
      }
    }
    // Drop the oldest in batches (a tenth over the limit) so a live stream doesn't splice every line.
    if (this.entries.length > this.maxEntries * 1.1 || (this.maxEntries < 100 && this.entries.length > this.maxEntries)) {
      const k = this.entries.length - this.maxEntries;
      this.entries.splice(0, k);
      this.search.splice(0, k);
    }
    this.changed();
  }

  setEntries(entries: readonly LogEntry[]) {
    this.entries = entries.slice().sort((a, b) => a.time - b.time);
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries);
    this.search = new Array(this.entries.length);
    this.changed();
  }

  clear() {
    this.entries = [];
    this.search = [];
    this.changed();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    this.version++;
    this.cache = null;
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

  /** The indices of the lines the filter lets through, oldest first. The last answer is cached. */
  query(f: LogFilter = {}): number[] {
    const key = `${f.levels ? f.levels.join(",") : "*"}|${f.text ?? ""}|${f.from ?? ""}|${f.to ?? ""}`;
    if (this.cache && this.cache.key === key && this.cache.version === this.version) return this.cache.result;
    const [a, b] = this.bounds(f);
    const levels = LogStore.levelMask(f);
    const needle = (f.text ?? "").trim().toLowerCase();
    const out: number[] = [];
    if (!levels && !needle) for (let i = a; i < b; i++) out.push(i);
    else for (let i = a; i < b; i++) if (this.passes(i, levels, needle)) out.push(i);
    this.cache = { key, version: this.version, result: out };
    return out;
  }

  /** How many lines of each level pass the filter's text and range (its levels ignored: the counts on the level toggles). */
  levelCounts(f: LogFilter = {}): Record<LogLevel, number> {
    const counts = [0, 0, 0, 0, 0, 0];
    const [a, b] = this.bounds(f);
    const needle = (f.text ?? "").trim().toLowerCase();
    for (let i = a; i < b; i++) if (!needle || this.text(i).indexOf(needle) >= 0) counts[LEVEL_INDEX[levelOf(this.entries[i].level)]]++;
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
    const a = this.lower(start);
    const b = this.upper(t1);
    for (let i = a; i < b; i++) {
      if (!this.passes(i, levels, needle)) continue;
      const e = this.entries[i];
      const k = Math.floor((e.time - start) / step);
      if (k >= 0 && k < buckets) counts[levelOf(e.level)][k]++;
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
