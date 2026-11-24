/**
 * Synthetic observability data: request rates, latency percentiles, CPU, and a large random walk with
 * incidents in it. Seeded, so tests and benchmarks see the same numbers every run.
 */

/** A small seeded PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `n` samples `stepMs` apart ending at `end`: a daily cycle, noise, slow drift, and a few incidents
 * (spikes and dropouts) a decimating renderer must not lose. Written for QuickJS: one inline xorshift
 * per random number and `var`s in the loop, so a million samples take a fraction of a second.
 */
export function randomWalk(n: number, options: { seed?: number; stepMs?: number; end?: number; series?: number } = {}) {
  const step = options.stepMs ?? 1000;
  const end = options.end ?? Date.UTC(2026, 10, 23, 12, 0, 0);
  const series = options.series ?? 1;
  const x = new Float64Array(n);
  const ys: Float64Array[] = [];
  for (let s = 0; s < series; s++) ys.push(new Float64Array(n));
  const start = end - (n - 1) * step;
  for (let i = 0; i < n; i++) x[i] = start + i * step;
  for (let s = 0; s < series; s++) fillWalk(ys[s], x, 0, n, (options.seed ?? 1) * 7919 + s * 104729, 100 + s * 40);
  return { x, ys };
}

/** Fills y[from, to) with the walk for times x; returns the state to carry on from. */
function fillWalk(y: Float64Array, x: Float64Array, from: number, to: number, seed: number, mean: number, state?: { level: number; rnd: number }) {
  var rnd = state ? state.rnd : (seed | 0) || 1;
  var level = state ? state.level : mean;
  var DAY = 86_400_000;
  var TAU = Math.PI * 2;
  for (var i = from; i < to; i++) {
    // Three xorshift32 draws summed: roughly normal noise.
    rnd ^= rnd << 13; rnd ^= rnd >>> 17; rnd ^= rnd << 5;
    var a = (rnd >>> 0) / 4294967296;
    rnd ^= rnd << 13; rnd ^= rnd >>> 17; rnd ^= rnd << 5;
    var b = (rnd >>> 0) / 4294967296;
    rnd ^= rnd << 13; rnd ^= rnd >>> 17; rnd ^= rnd << 5;
    var c = (rnd >>> 0) / 4294967296;
    level += (a + b - 1) * 1.2 + (mean - level) * 0.001;
    y[i] = level + Math.sin(((x[i] % DAY) / DAY) * TAU) * 25 + (c - 0.5) * 8;
  }
  // Incidents: a few one-sample spikes and a dropout.
  const r = rng(seed + from);
  const n = to - from;
  for (let k = 0; k < Math.max(1, Math.round((n / 1_000_000) * 5)); k++) y[from + Math.floor(r() * n)] += 250 + r() * 200;
  if (n > 1000) {
    const gap = from + Math.floor(n * (0.3 + r() * 0.4));
    y.fill(NaN, gap, Math.min(to, gap + Math.max(3, Math.floor(n / 2000))));
  }
  return { level, rnd };
}

/**
 * The same walk in chunks of `chunk` samples, handed to `onChunk` one turn of the event loop apart, so
 * that building ten million samples on QuickJS never runs into NSH's limit of 2 s per call into JS.
 */
export async function randomWalkChunks(
  n: number,
  onChunk: (x: Float64Array, y: Float64Array) => void,
  options: { seed?: number; stepMs?: number; end?: number; chunk?: number } = {},
) {
  const step = options.stepMs ?? 1000;
  const end = options.end ?? Date.UTC(2026, 10, 23, 12, 0, 0);
  const chunk = options.chunk ?? 250_000;
  const start = end - (n - 1) * step;
  let state: { level: number; rnd: number } | undefined;
  for (let from = 0; from < n; from += chunk) {
    const k = Math.min(chunk, n - from);
    const x = new Float64Array(k);
    for (let i = 0; i < k; i++) x[i] = start + (from + i) * step;
    const y = new Float64Array(k);
    state = fillWalk(y, x, 0, k, (options.seed ?? 1) * 7919 + from, 100, state);
    onChunk(x, y);
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** A sum of 12 uniforms: roughly normal, mean 0, sd 1. */
function gauss(r: () => number) {
  let s = 0;
  for (let i = 0; i < 12; i++) s += r();
  return s - 6;
}

/**
 * A live source of service metrics: one sample per call to `next(t)`. `incidents` are [start, end] times
 * when latency, errors and CPU rise; after the last one, incidents come at random, now and then.
 */
export function serviceMetrics(seed = 7, incidents: [number, number][] = []) {
  const planned = incidents.length ? Math.max(...incidents.map((i) => i[1])) : -Infinity;
  const r = rng(seed);
  let rate = 1200;
  let cpu = [35, 42, 28, 55];
  let incident = 0;
  // Each sample is an aggregate (a rate, a percentile over a window), so the noise is smoothed, as a
  // metrics backend's rollups are: an AR(1) process per signal instead of fresh noise every 100 ms.
  const n = new Array(6).fill(0);
  const smooth = (i: number, a = 0.92) => (n[i] = n[i] * a + gauss(r) * Math.sqrt(1 - a * a));
  let hot = 0;
  return {
    /** Request rate (req/s), errors (req/s), p50 / p95 / p99 latency (ms), and 4 hosts' CPU (%). */
    next(t: number) {
      const minute = (t / 60_000) % 60;
      rate += (1200 + Math.sin(minute / 9.5) * 300 - rate) * 0.02 + smooth(0) * 9;
      if (t > planned && incident <= 0 && r() < 0.0004) incident = 80 + Math.floor(r() * 120);
      if (incident > 0) incident--;
      const on = incident > 0 || incidents.some(([a, b]) => t >= a && t < b);
      // Incidents ramp in and out over a couple of seconds.
      hot += ((on ? 1 : 0) - hot) * 0.08;
      const errors = Math.max(0, rate * (0.004 + hot * 0.05) * (1 + smooth(1) * 0.25));
      const p50 = 42 + smooth(2) * 2.5 + hot * 30;
      const p95 = p50 * 2.5 + smooth(3) * 6 + hot * 120;
      const p99 = p95 * 1.75 + smooth(4) * 14 + hot * 200;
      cpu = cpu.map((c, i) => Math.max(1, Math.min(100, c + (40 + i * 6 - c) * 0.01 + gauss(r) * 0.6 + hot * 0.6)));
      return { rate, errors, p50, p95, p99, cpu };
    },
  };
}
