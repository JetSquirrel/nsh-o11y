/**
 * The store's pyramid and tracer against brute force: every min/max query, every decimated column, in
 * every way the data can arrive (all at once, appended in chunks, one by one, trimmed to a window).
 */
import { describe, expect, test } from "nsh/test";
import { TimeSeries, type TraceOptions } from "../src/store";
import { randomWalk, randomWalkChunks, rng } from "./data";

/** Gives the host a turn: NSH stops a single call into JS after 2 s. */
const tick = () => new Promise((r) => setTimeout(r, 0));

function brute(y: ArrayLike<number>, a: number, b: number): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = a; i < b; i++) {
    const v = y[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
}

/** Parses the tracer's SVG path data back into points (x, y), with NaN separating subpaths. */
function points(d: string): number[][] {
  const out: number[][] = [];
  const re = /([MLVHZ])([^MLVHZ]*)/g;
  let m: RegExpExecArray | null;
  let x = 0;
  let y = 0;
  while ((m = re.exec(d))) {
    const nums = m[2].trim().split(/[ ,]+/).filter(Boolean).map(Number);
    switch (m[1]) {
      case "M":
        out.push([NaN, NaN]);
        [x, y] = nums;
        break;
      case "L":
        [x, y] = nums;
        break;
      case "V":
        y = nums[0];
        break;
      case "H":
        x = nums[0];
        break;
      case "Z":
        continue;
    }
    out.push([x, y]);
  }
  return out;
}

const VIEW: Omit<TraceOptions, "x0" | "x1" | "y0" | "y1"> = { left: 20, top: 10, width: 600, height: 300 };

describe("pyramid", () => {
  test("extents match a scan, for many ranges", () => {
    const { x, ys } = randomWalk(100_000, { seed: 3 });
    const t = TimeSeries.from(x, ys);
    const r = rng(9);
    const y = t.values(0);
    for (let k = 0; k < 60; k++) {
      const a = Math.floor(r() * 100_000);
      const b = a + Math.floor(r() * (100_000 - a)) + 1;
      expect(t.extent(0, a, b)).toEqual(brute(y, a, b));
    }
    expect(t.extent(0, 0, 100_000)).toEqual(brute(y, 0, 100_000));
    expect(t.extent(0, 5, 5)).toEqual([Infinity, -Infinity]);
  });

  test("appending in chunks or one by one builds the same pyramid as setData", () => {
    const { x, ys } = randomWalk(40_000, { seed: 4, series: 2 });
    const whole = TimeSeries.from(x, ys);
    const chunks = new TimeSeries({ series: 2 });
    for (let i = 0; i < 40_000; i += 1234) {
      const e = Math.min(40_000, i + 1234);
      chunks.append(x.subarray(i, e), [ys[0].subarray(i, e), ys[1].subarray(i, e)]);
    }
    const ones = new TimeSeries({ series: 2 });
    for (let i = 0; i < 5000; i++) ones.append(x[i], [ys[0][i], ys[1][i]]);
    for (const [a, b] of [[0, 40_000], [17, 39_000], [4095, 4097], [100, 30_000]]) {
      for (const s of [0, 1]) expect(chunks.extent(s, a, b)).toEqual(whole.extent(s, a, b));
    }
    for (const [a, b] of [[0, 5000], [9, 4999], [511, 4097]]) {
      expect(ones.extent(1, a, b)).toEqual(brute(ys[1], a, b));
    }
  });

  test("maxPoints keeps the newest samples and stays exact", () => {
    const { x, ys } = randomWalk(60_000, { seed: 5 });
    const t = new TimeSeries({ maxPoints: 10_000 });
    for (let i = 0; i < 60_000; i += 300) t.append(x.subarray(i, i + 300), [ys[0].subarray(i, i + 300)]);
    expect(t.length()).toBeGreaterThanOrEqual(10_000);
    expect(t.length()).toBeLessThanOrEqual(10_000 + 1250 + 300);
    expect(t.x(t.length() - 1)).toBe(x[59_999]);
    const n = t.length();
    const tail = ys[0].subarray(60_000 - n);
    expect(t.extent(0, 0, n)).toEqual(brute(tail, 0, n));
    expect(t.extent(0, 33, n - 7)).toEqual(brute(tail, 33, n - 7));
    // One at a time too.
    const u = new TimeSeries({ maxPoints: 1000 });
    for (let i = 0; i < 5000; i++) u.append(x[i], [ys[0][i]]);
    const m = u.length();
    expect(u.extent(0, 0, m)).toEqual(brute(ys[0].subarray(5000 - m, 5000), 0, m));
  });

  test("search finds samples by time", () => {
    const t = TimeSeries.from([10, 20, 20, 30], [[1, 2, 3, 4]]);
    expect(t.lowerBound(20)).toBe(1);
    expect(t.upperBound(20)).toBe(3);
    expect(t.lowerBound(5)).toBe(0);
    expect(t.lowerBound(99)).toBe(4);
    expect(t.nearest(24)).toBe(2);
    expect(t.nearest(26)).toBe(3);
    expect(t.nearest(-1)).toBe(0);
  });
});

describe("tracing", () => {
  test("few samples are drawn one by one", () => {
    const t = TimeSeries.from([0, 1, 2, 3], [[0, 10, 5, 10]]);
    const d = t.trace(0, { ...VIEW, x0: 0, x1: 3, y0: 0, y1: 10 });
    expect(t.stats.decimated).toBe(false);
    expect(points(d).filter((p) => !isNaN(p[0]))).toEqual([[20, 310], [220, 10], [420, 160], [620, 10]]);
  });

  test("a million samples decimate to at most 4 points a pixel column, keeping every extreme", async () => {
    const n = 1_000_000;
    const t = new TimeSeries({ capacity: n });
    await randomWalkChunks(n, (cx, cy) => t.append(cx, [cy]), { seed: 6, chunk: 100_000 });
    const x = t.times();
    await tick();
    const x0 = x[0];
    const x1 = x[n - 1];
    const [lo, hi] = t.extent(0, 0, n);
    const d = t.trace(0, { ...VIEW, x0, x1, y0: lo, y1: hi });
    expect(t.stats.decimated).toBe(true);
    expect(t.stats.points).toBeLessThanOrEqual(4 * (VIEW.width + 2));
    const pts = points(d).filter((p) => !isNaN(p[0]));
    // Each column's drawn y span covers the samples in it.
    const cols = VIEW.width;
    const colW = (x1 - x0) / cols;
    const y = t.values(0);
    const ky = VIEW.height / (hi - lo);
    let a = 0;
    let checked = 0;
    for (let c = 0; c < cols; c += 37) {
      const start = t.lowerBound(x0 + c * colW);
      const end = t.lowerBound(x0 + (c + 1) * colW);
      if (end <= start) continue;
      const [cl, ch] = brute(y, start, end);
      if (!(cl <= ch)) continue;
      const px = Math.round((VIEW.left + (c + 0.5) * (VIEW.width / cols)) * 10) / 10;
      const ysAt = pts.filter((p) => Math.abs(p[0] - px) < 0.051).map((p) => p[1]);
      expect(ysAt.length).toBeGreaterThan(0);
      const top = VIEW.top + VIEW.height - (ch - lo) * ky;
      const bottom = VIEW.top + VIEW.height - (cl - lo) * ky;
      expect(Math.min(...ysAt)).toBeLessThanOrEqual(top + 0.06);
      expect(Math.max(...ysAt)).toBeGreaterThanOrEqual(bottom - 0.06);
      checked++;
      a = end;
    }
    void a;
    expect(checked).toBeGreaterThan(10);
  });

  test("a spike of one sample in a million is drawn", async () => {
    const n = 1_000_000;
    const t = new TimeSeries({ capacity: n });
    for (let from = 0; from < n; from += 100_000) {
      const x = new Float64Array(100_000);
      const y = new Float64Array(100_000);
      for (let i = 0; i < 100_000; i++) {
        x[i] = from + i;
        y[i] = from + i === 612_345 ? 50 : Math.sin((from + i) / 5000);
      }
      t.append(x, [y]);
      await tick();
    }
    const d =t.trace(0, { ...VIEW, x0: 0, x1: n - 1, y0: -1, y1: 50 });
    const minY = Math.min(...points(d).filter((p) => !isNaN(p[1])).map((p) => p[1]));
    expect(minY).toBe(VIEW.top);
  });

  test("gaps break the line, unless spanGaps", () => {
    const y = [1, 2, 3, NaN, NaN, 4, 5];
    const t = TimeSeries.from([0, 1, 2, 3, 4, 5, 6], [y]);
    const o = { ...VIEW, x0: 0, x1: 6, y0: 0, y1: 5 };
    expect(t.trace(0, o).split("M").length - 1).toBe(2);
    expect(t.trace(0, { ...o, spanGaps: true }).split("M").length - 1).toBe(1);
    // Decimated too: a long run of NaN is a gap.
    const n = 200_000;
    const big = new Float64Array(n).map((_, i) => Math.sin(i / 1000));
    big.fill(NaN, 80_000, 90_000);
    const u = TimeSeries.from(new Float64Array(n).map((_, i) => i), [big]);
    expect(u.trace(0, { ...VIEW, x0: 0, x1: n - 1, y0: -1, y1: 1 }).split("M").length - 1).toBe(2);
  });

  test("a fill closes each run down to the baseline", () => {
    const t = TimeSeries.from([0, 1, 2], [[1, 2, 1]]);
    const d = t.trace(0, { ...VIEW, x0: 0, x1: 2, y0: 0, y1: 2, baseline: 310 });
    expect(d.startsWith("M20 310V")).toBe(true);
    expect(d.endsWith("V310H20Z")).toBe(true);
  });

  test("steps hold each value until the next sample", () => {
    const t = TimeSeries.from([0, 1, 2], [[0, 2, 1]]);
    const d = t.trace(0, { ...VIEW, x0: 0, x1: 2, y0: 0, y1: 2, step: true });
    expect(d).toBe("M20 310H320V10H620V160");
  });

  test("zoomed in, only the samples in view (and one either side) are read", async () => {
    const n = 1_000_000;
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = i * 1000;
    await tick();
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = i % 7;
    await tick();
    const t = TimeSeries.from(x, [y]);
    await tick();
    t.trace(0, { ...VIEW, x0: 500_000_000, x1: 500_100_000, y0: 0, y1: 7 });
    expect(t.stats.samples).toBe(103);
    expect(t.stats.decimated).toBe(false);
  });
});
