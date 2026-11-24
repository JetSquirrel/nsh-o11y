/**
 * Axis ticks and value formatting: time ticks on calendar-friendly steps, value ticks on 1-2-5 steps,
 * and the units observability data comes in (SI counts, bytes, durations, percentages).
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The steps time ticks go in, in ms. Months and years are handled apart (they are not a fixed length). */
const TIME_STEPS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500,
  SECOND, 2 * SECOND, 5 * SECOND, 10 * SECOND, 15 * SECOND, 30 * SECOND,
  MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE,
  HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR,
  DAY, 2 * DAY, 7 * DAY, 14 * DAY,
];
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

export type TimeZone = "local" | "utc";

export interface Tick {
  value: number;
  label: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad(n: number, w = 2) {
  let s = String(n);
  while (s.length < w) s = "0" + s;
  return s;
}

interface Parts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  ms: number;
}

function parts(t: number, tz: TimeZone): Parts {
  const dt = new Date(t);
  return tz === "utc"
    ? { y: dt.getUTCFullYear(), mo: dt.getUTCMonth(), d: dt.getUTCDate(), h: dt.getUTCHours(), mi: dt.getUTCMinutes(), s: dt.getUTCSeconds(), ms: dt.getUTCMilliseconds() }
    : { y: dt.getFullYear(), mo: dt.getMonth(), d: dt.getDate(), h: dt.getHours(), mi: dt.getMinutes(), s: dt.getSeconds(), ms: dt.getMilliseconds() };
}

function make(p: Parts, tz: TimeZone): number {
  return tz === "utc" ? Date.UTC(p.y, p.mo, p.d, p.h, p.mi, p.s, p.ms) : new Date(p.y, p.mo, p.d, p.h, p.mi, p.s, p.ms).getTime();
}

/** How a time reads at a tick step: finer steps show finer parts. */
export function formatTime(t: number, step: number, tz: TimeZone = "local"): string {
  const p = parts(t, tz);
  if (step < SECOND) return `${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}.${pad(p.ms, 3)}`;
  if (step < MINUTE) return `${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
  if (step < DAY) {
    // Midnight names the day instead, so a range over days still says which.
    if (p.h === 0 && p.mi === 0) return `${MONTHS[p.mo]} ${p.d}`;
    return `${pad(p.h)}:${pad(p.mi)}`;
  }
  if (step < MONTH) return `${MONTHS[p.mo]} ${p.d}`;
  if (step < YEAR) return p.mo === 0 ? String(p.y) : MONTHS[p.mo];
  return String(p.y);
}

/** A time in full, for the cursor's readout. */
export function formatTimeFull(t: number, span: number, tz: TimeZone = "local"): string {
  const p = parts(t, tz);
  const date = `${p.y}-${pad(p.mo + 1)}-${pad(p.d)}`;
  const time = `${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
  return span < 10 * SECOND ? `${date} ${time}.${pad(p.ms, 3)}` : `${date} ${time}`;
}

/** Time ticks over [t0, t1] at least `minGap` points apart along `width` points. */
export function timeTicks(t0: number, t1: number, width: number, minGap = 80, tz: TimeZone = "local"): { step: number; ticks: Tick[] } {
  const span = t1 - t0;
  if (!(span > 0) || !(width > 0)) return { step: 0, ticks: [] };
  const want = (span * minGap) / width;
  const ticks: Tick[] = [];
  if (want > TIME_STEPS[TIME_STEPS.length - 1]) {
    // Months or years: walk the calendar.
    const months = want > YEAR ? Math.ceil(want / YEAR) * 12 : want > 6 * MONTH ? 12 : want > 3 * MONTH ? 6 : want > MONTH ? 3 : 1;
    const p = parts(t0, tz);
    // From the first month on the step at or before t0; the walk skips what comes before t0.
    let mo = Math.floor(p.mo / months) * months;
    for (let guard = 0; guard < 500; guard++) {
      const t = make({ y: p.y + Math.floor(mo / 12), mo: mo % 12, d: 1, h: 0, mi: 0, s: 0, ms: 0 }, tz);
      if (t > t1) break;
      if (t >= t0) ticks.push({ value: t, label: formatTime(t, months * MONTH, tz) });
      mo += months;
    }
    return { step: months * MONTH, ticks };
  }
  let step = TIME_STEPS[TIME_STEPS.length - 1];
  for (const s of TIME_STEPS) {
    if (s >= want) {
      step = s;
      break;
    }
  }
  // Align to the step in the time zone: whole hours, days start at midnight.
  let start: number;
  if (step < HOUR || tz === "utc") {
    const offset = tz === "utc" || step < MINUTE ? 0 : -new Date(t0).getTimezoneOffset() * MINUTE;
    start = Math.ceil((t0 + offset) / step) * step - offset;
    if (step >= DAY && tz === "utc") start = Math.ceil(t0 / step) * step;
  } else {
    const p = parts(t0, tz);
    if (step < DAY) {
      const hours = step / HOUR;
      start = make({ ...p, h: Math.floor(p.h / hours) * hours, mi: 0, s: 0, ms: 0 }, tz);
    } else start = make({ ...p, h: 0, mi: 0, s: 0, ms: 0 }, tz);
    while (start < t0) start = step >= DAY ? make({ ...parts(start, tz), d: parts(start, tz).d + step / DAY }, tz) : start + step;
  }
  for (let t = start, guard = 0; t <= t1 && guard < 1000; guard++) {
    ticks.push({ value: t, label: formatTime(t, step, tz) });
    // Days step on the calendar, so daylight saving time keeps ticks at midnight.
    t = step >= DAY && tz === "local" ? make({ ...parts(t, tz), d: parts(t, tz).d + step / DAY }, tz) : t + step;
  }
  return { step, ticks };
}

/** The smallest calendar-friendly time step (1 s, 5 s, 1 min, 5 min, 1 h…) at least `raw` ms: bucket widths. */
export function timeStep(raw: number): number {
  if (!(raw > 0)) return TIME_STEPS[0];
  for (const s of TIME_STEPS) if (s >= raw) return s;
  return Math.ceil(raw / DAY) * DAY;
}

/** A 1-2-5 step near `raw`. */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !isFinite(raw)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

/** Value ticks over [v0, v1] about `minGap` points apart along `height` points. */
export function valueTicks(v0: number, v1: number, height: number, minGap = 32): number[] {
  const span = v1 - v0;
  if (!(span > 0) || !(height > 0)) return [];
  const step = niceStep((span * minGap) / height);
  const out: number[] = [];
  const first = Math.ceil(v0 / step - 1e-9);
  for (let k = first, guard = 0; guard < 200; k++, guard++) {
    const v = k * step;
    if (v > v1 + step * 1e-9) break;
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return out;
}

/**
 * Pads a value range to round ends, as an auto-scaled axis shows it: the range out to the next tick
 * steps, `softMin` / `softMax` pulled in when the data stays on their side (0 for counts and rates), and a
 * flat range opened up around its value.
 */
export function niceRange(lo: number, hi: number, height: number, softMin?: number, softMax?: number): [number, number] {
  if (!(lo <= hi)) {
    lo = softMin ?? 0;
    hi = softMax ?? 1;
  }
  if (softMin !== undefined && softMin < lo) lo = softMin;
  if (softMax !== undefined && softMax > hi) hi = softMax;
  if (hi === lo) {
    const pad = lo === 0 ? 1 : Math.abs(lo) * 0.1;
    lo -= pad;
    hi += pad;
    if (softMin !== undefined && lo < softMin && hi > softMin) lo = softMin;
  }
  const step = niceStep(((hi - lo) * 32) / Math.max(40, height));
  const nlo = Math.floor(lo / step) * step;
  const nhi = Math.ceil(hi / step) * step;
  return [nlo, nhi === nlo ? nlo + step : nhi];
}

/** Units values come in. A function formats them itself. */
export type Unit =
  | "none"
  | "short" // 1.2k, 3.4M, SI prefixes
  | "percent" // 0–100
  | "percentunit" // 0–1
  | "bytes" // IEC: KiB, MiB
  | "decbytes" // SI: kB, MB
  | "bits" // b/s style counts: kb, Mb
  | "ms" // durations
  | "s"
  | "ns"
  | "reqps" // requests per second
  | "ops"
  | ((v: number) => string);

/** Digits after the point that tell values `step` apart. */
function decimalsFor(step: number) {
  if (!(step > 0) || !isFinite(step)) return 2;
  return Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9) + (step / Math.pow(10, Math.floor(Math.log10(step))) === 2.5 ? 1 : 0)));
}

function trimZeros(s: string) {
  return s.indexOf(".") < 0 ? s : s.replace(/\.?0+$/, "");
}

function fixed(v: number, d: number) {
  return trimZeros(v.toFixed(d));
}

const SI = ["", "k", "M", "G", "T", "P", "E"];
const SI_SMALL = ["", "m", "µ", "n", "p"];

function scaled(v: number, base: number, names: string[], suffix: string, step?: number, space = "") {
  const a = Math.abs(v);
  // Scale by the step (so ticks on one axis share a prefix) or by the value.
  const ref = step !== undefined && step > 0 ? Math.max(step, a) : a;
  let i = 0;
  let r = ref;
  while (r >= base && i < names.length - 1) {
    r /= base;
    i++;
  }
  const scale = Math.pow(base, i);
  const d = step !== undefined && step > 0 ? decimalsFor(step / scale) : a / scale >= 100 ? 0 : a / scale >= 10 ? 1 : 2;
  return fixed(v / scale, d) + space + names[i] + suffix;
}

function duration(v: number, unit: "ns" | "ms" | "s", step?: number): string {
  // Everything in ms, then pick a unit.
  const ms = unit === "s" ? v * 1000 : unit === "ns" ? v / 1e6 : v;
  const a = Math.max(Math.abs(ms), step !== undefined ? Math.abs(unit === "s" ? step * 1000 : unit === "ns" ? step / 1e6 : step) : 0);
  const units: [number, string][] = [
    [DAY, "d"], [HOUR, "h"], [MINUTE, "min"], [1000, "s"], [1, "ms"], [1e-3, "µs"], [1e-6, "ns"],
  ];
  for (const [size, name] of units) {
    if (a >= size || size === 1e-6) {
      const st = step !== undefined ? (unit === "s" ? step * 1000 : unit === "ns" ? step / 1e6 : step) / size : undefined;
      const d = st !== undefined ? decimalsFor(st) : Math.abs(ms / size) >= 100 ? 0 : Math.abs(ms / size) >= 10 ? 1 : 2;
      return fixed(ms / size, d) + " " + name;
    }
  }
  return String(v);
}

/** Formats `v` in `unit`. `step` (the axis's tick step) keeps the ticks of one axis alike. */
export function formatValue(v: number, unit: Unit = "short", step?: number): string {
  if (v !== v) return "–";
  if (typeof unit === "function") return unit(v);
  switch (unit) {
    case "none":
      return fixed(v, step !== undefined ? decimalsFor(step) : Math.abs(v) >= 100 ? 0 : 2);
    case "percent":
      return fixed(v, step !== undefined ? decimalsFor(step) : Math.abs(v) >= 10 ? 1 : 2) + "%";
    case "percentunit":
      return fixed(v * 100, step !== undefined ? decimalsFor(step * 100) : Math.abs(v) >= 0.1 ? 1 : 2) + "%";
    case "bytes":
      return scaled(v, 1024, ["B", "KiB", "MiB", "GiB", "TiB", "PiB"], "", step, " ");
    case "decbytes":
      return scaled(v, 1000, ["B", "kB", "MB", "GB", "TB", "PB"], "", step, " ");
    case "bits":
      return scaled(v, 1000, ["b", "kb", "Mb", "Gb", "Tb", "Pb"], "", step, " ");
    case "ms":
    case "s":
    case "ns":
      return v === 0 ? "0" : duration(v, unit, step);
    case "reqps":
      return scaled(v, 1000, SI, "", step) + " req/s";
    case "ops":
      return scaled(v, 1000, SI, "", step) + " ops/s";
    case "short":
    default: {
      const a = Math.abs(v);
      if (a !== 0 && a < 1 && (step === undefined || step < 1)) {
        // Small values: as decimals down to a thousandth, then milli, micro…
        if (a >= 0.001 || (step !== undefined && step >= 0.001)) return fixed(v, step !== undefined ? decimalsFor(step) : 3);
        let i = 0;
        let r = a;
        while (r < 1 && i < SI_SMALL.length - 1) {
          r *= 1000;
          i++;
        }
        return fixed(v * Math.pow(1000, i), 2) + SI_SMALL[i];
      }
      return scaled(v, 1000, SI, "", step);
    }
  }
}
