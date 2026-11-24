/**
 * One library, one scenario, per page load (`?lib=echarts&scenario=1000000`): run.ts opens a fresh browser
 * for each, so one library's garbage or a crash can't touch the next. Same data generator, sizes and plot
 * size as perf/perf.test.ts: 1000 × 300 CSS px at 1×, one series.
 *
 * - full:  the whole series in view, the x range set again (alternately 1 ms wider) so that every frame
 *          recomputes as a pan or a resize would: no library can serve it from a cache.
 * - zoom:  30 frames, each 1.25× further in toward the middle, as a wheel zooms.
 * - hover: the cursor moved, and what that draws (crosshair, tooltip or legend).
 */
import { randomWalkChunks } from "../../../example/data";
import { adapters, type Adapter, type Data } from "./adapters";

const W = 1000;
const H = 300;
/** Stop timing a scenario once its frames have taken this long (at least 3 frames). */
const BUDGET_MS = 20_000;

const q = new URLSearchParams(location.search);
const lib: Adapter = adapters[q.get("lib") ?? ""];
const scenario = q.get("scenario") ?? "";
const log = (msg: string) => {
  document.getElementById("log")!.textContent += msg + "\n";
};
const tick = () => new Promise((r) => setTimeout(r, 0));

async function walk(n: number, series = 1, seed = 1, chunk = 250_000): Promise<Data> {
  const x = new Float64Array(n);
  const ys: Float64Array[] = [];
  for (let s = 0; s < series; s++) {
    const y = new Float64Array(n);
    let at = 0;
    await randomWalkChunks(n, (cx, cy) => {
      if (s === 0) x.set(cx, at);
      y.set(cy, at);
      at += cx.length;
    }, { seed: seed + s, chunk });
    ys.push(y);
  }
  return { x, ys };
}

interface Stats { mean: number; p95: number; frames: number }

async function timed(n: number, step: (i: number) => void | Promise<void>): Promise<Stats> {
  const ms: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await step(i);
    const d = performance.now() - t0;
    ms.push(d);
    total += d;
    if (i % 5 === 4) await tick();
    if (total > BUDGET_MS && ms.length >= 3) break;
  }
  ms.sort((a, b) => a - b);
  return {
    mean: ms.reduce((s, v) => s + v, 0) / ms.length,
    p95: ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))],
    frames: ms.length,
  };
}

async function size(n: number) {
  const d = await walk(n);
  const prepared = lib.prepare(d);
  await tick();
  const t0 = performance.now();
  const h = await lib.create(document.body, prepared, W, H);
  const create = performance.now() - t0;
  await tick();
  const x0 = d.x[0];
  const x1 = d.x[n - 1];
  const full = await timed(20, (i) => lib.setX(h, x0, x1 + (i % 2)));
  let a = x0;
  let b = x1;
  const zoom = await timed(30, () => {
    const mid = (a + b) / 2;
    const half = (b - a) / 2 / 1.25;
    a = mid - half;
    b = mid + half;
    return lib.setX(h, a, b);
  });
  // Hover over the full view.
  await lib.setX(h, x0, x1);
  const hover = lib.hover ? await timed(60, (i) => lib.hover!(h, 20 + ((i * 13) % (W - 120)))) : undefined;
  return { create, full, zoom, hover };
}

async function live() {
  const keep = 1_000_000;
  const d = await walk(keep);
  const l = await lib.live(document.body, d, W, H, keep);
  await tick();
  let t = d.x[keep - 1];
  const full = await timed(120, () => {
    t += 100;
    return l.step(t, Math.random() * 100, t - 300_000, t);
  });
  return { full };
}

async function dashboard() {
  if (lib.noDashboard) return { skipped: lib.noDashboard };
  const hs: any[] = [];
  let x0 = 0;
  let x1 = 0;
  for (let p = 0; p < 24; p++) {
    const d = await walk(20_000, 3, p * 3 + 1, 20_000);
    x0 = d.x[0];
    x1 = d.x[d.x.length - 1];
    hs.push(await lib.create(document.body, lib.prepare(d), 400, 180));
  }
  await tick();
  const full = await timed(10, async (i) => {
    for (const h of hs) await lib.setX(h, x0, x1 + (i % 2));
  });
  return { full };
}

/** `?scenario=shot`: just draws 100k samples, for a screenshot that shows each library is set up right. */
async function shot() {
  const d = await walk(100_000);
  const h = await lib.create(document.body, lib.prepare(d), W, H);
  await lib.setX(h, d.x[0] + (d.x[99_999] - d.x[0]) * 0.4, d.x[99_999]);
  if (lib.hover) lib.hover(h, 500);
  document.getElementById("log")!.textContent = lib.name;
}

(async () => {
  if (scenario === "shot") return shot();
  const post = (body: any) =>
    fetch("/result", { method: "POST", body: JSON.stringify({ lib: q.get("lib"), scenario, userAgent: navigator.userAgent, ...body }) });
  try {
    if (!lib) throw new Error(`no adapter ${q.get("lib")}`);
    const r = scenario === "live" ? await live() : scenario === "dashboard" ? await dashboard() : await size(Number(scenario));
    log(JSON.stringify(r));
    await post({ ok: true, ...r });
  } catch (e: any) {
    await post({ ok: false, error: String((e && e.stack) || e) });
  }
})();
