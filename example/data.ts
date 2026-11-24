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

/** A live source of service metrics: one sample per call to `next(t)`. */
export function serviceMetrics(seed = 7) {
  const r = rng(seed);
  let rate = 1200;
  let cpu = [35, 42, 28, 55];
  let incident = 0;
  return {
    /** Request rate (req/s), errors (req/s), p50 / p95 / p99 latency (ms), and 4 hosts' CPU (%). */
    next(t: number) {
      const minute = (t / 60_000) % 60;
      rate += (1200 + Math.sin(minute / 9.5) * 300 - rate) * 0.05 + gauss(r) * 25;
      if (incident <= 0 && r() < 0.002) incident = 40 + Math.floor(r() * 60);
      const hot = incident > 0 ? 1 : 0;
      if (incident > 0) incident--;
      const errors = Math.max(0, rate * (0.004 + hot * 0.05) + gauss(r) * 2);
      const p50 = 42 + gauss(r) * 3 + hot * 30;
      const p95 = p50 * (2.4 + r() * 0.3) + hot * 120;
      const p99 = p95 * (1.6 + r() * 0.4) + hot * 200;
      cpu = cpu.map((c, i) => Math.max(1, Math.min(100, c + (40 + i * 6 - c) * 0.03 + gauss(r) * 2 + hot * 1.5)));
      return { rate, errors, p50, p95, p99, cpu };
    },
  };
}
