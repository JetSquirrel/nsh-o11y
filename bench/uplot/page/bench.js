// uPlot on the scenarios of perf/perf.test.ts, in a browser: same data generator, same sizes, same plot
// size (1000 × 300 CSS px at 1×), one series, timed with performance.now() around uPlot's synchronous
// `batch`, which commits (builds the paths and draws) before it returns.
import uPlot from "../node_modules/uplot/dist/uPlot.esm.js";
import { randomWalkChunks } from "./data.js";

const W = 1000;
const H = 300;
const out = [];
const log = (msg) => {
  document.getElementById("log").textContent += msg + "\n";
};
const tick = () => new Promise((r) => setTimeout(r, 0));

async function walk(n, seed = 1, chunk = 250_000) {
  const x = new Float64Array(n);
  // uPlot reads null as a gap; NaN would be drawn as a broken coordinate.
  const y = new Array(n);
  let at = 0;
  await randomWalkChunks(n, (cx, cy) => {
    x.set(cx, at);
    for (let i = 0; i < cy.length; i++) y[at + i] = cy[i] === cy[i] ? cy[i] : null;
    at += cx.length;
  }, { seed, chunk });
  return [x, y];
}

function stats(ms) {
  ms.sort((a, b) => a - b);
  return { mean: ms.reduce((s, v) => s + v, 0) / ms.length, p95: ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))] };
}

async function timed(n, step) {
  const ms = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    step(i);
    ms.push(performance.now() - t0);
    if (i % 5 === 4) await tick();
  }
  return stats(ms);
}

function opts(width, height, series = 1) {
  return {
    width,
    height,
    pxRatio: 1,
    legend: { show: true, live: true },
    cursor: { drag: { x: true, y: false } },
    scales: { x: { time: true } },
    series: [{}, ...Array.from({ length: series }, (_, i) => ({ label: `s${i}`, stroke: ["#2a78d6", "#eb6834", "#1baf7a"][i % 3], width: 1.5 }))],
    axes: [{}, {}],
  };
}

async function scenario(n) {
  const data = await walk(n);
  const el = document.createElement("div");
  document.body.appendChild(el);
  // uPlot's x scale is in seconds when `time` is on.
  const xs = Float64Array.from(data[0], (v) => v / 1000);
  const d = [xs, data[1]];
  await tick();
  const t0 = performance.now();
  const u = new uPlot(opts(W, H), d, el);
  u.batch(() => {});
  const create = performance.now() - t0;
  await tick();
  const full = await timed(20, () => u.batch(() => u.redraw(true, true)));
  // Zoom in toward the middle, 1.25× a frame.
  let min = xs[0];
  let max = xs[xs.length - 1];
  const zoom = await timed(30, () => {
    const mid = (min + max) / 2;
    const half = (max - min) / 2 / 1.25;
    min = mid - half;
    max = mid + half;
    u.batch(() => u.setScale("x", { min, max }));
  });
  const hover = await timed(60, (i) => u.setCursor({ left: (i * 13) % u.bbox.width, top: 100 }));
  u.destroy();
  el.remove();
  out.push({ scenario: `${n.toLocaleString("en-US")} samples`, create, full, zoom, hover });
  log(`${n}: create ${create.toFixed(1)} full ${full.mean.toFixed(2)} zoom ${zoom.mean.toFixed(2)} hover ${hover.mean.toFixed(3)}`);
}

async function live() {
  const n = 1_000_000;
  const [x, y] = await walk(n);
  const xs = Array.from(x, (v) => v / 1000);
  const d = [xs, y];
  const el = document.createElement("div");
  document.body.appendChild(el);
  const u = new uPlot(opts(W, H), d, el);
  let t = xs[xs.length - 1];
  const r = await timed(120, () => {
    t += 0.1;
    xs.push(t);
    y.push(Math.random() * 100);
    // Keep about 1M, as the store's maxPoints does (uPlot keeps no ring buffer: drop from the front in batches).
    if (xs.length > n + n / 8) {
      xs.splice(0, xs.length - n);
      y.splice(0, y.length - n);
    }
    u.batch(() => {
      u.setData(d, false);
      u.setScale("x", { min: t - 300, max: t });
    });
  });
  u.destroy();
  el.remove();
  out.push({ scenario: "live, 1M kept, 3000 in view", full: r });
  log(`live ${r.mean.toFixed(2)} / ${r.p95.toFixed(2)}`);
}

async function dashboard() {
  const charts = [];
  for (let p = 0; p < 24; p++) {
    const cols = [];
    let x;
    for (let s = 0; s < 3; s++) {
      const [cx, cy] = await walk(20_000, p * 3 + s + 1, 20_000);
      x = cx;
      cols.push(cy);
    }
    const el = document.createElement("div");
    document.body.appendChild(el);
    charts.push(new uPlot(opts(400, 180, 3), [Float64Array.from(x, (v) => v / 1000), ...cols], el));
  }
  await tick();
  const r = await timed(10, () => {
    for (const u of charts) u.batch(() => u.redraw(true, true));
  });
  for (const u of charts) u.destroy();
  out.push({ scenario: "24 panels × 3 × 20k", full: r });
  log(`dashboard ${r.mean.toFixed(2)} / ${r.p95.toFixed(2)}`);
}

(async () => {
  try {
    for (const n of [100_000, 1_000_000, 10_000_000]) await scenario(n);
    await live();
    await dashboard();
    await fetch("/result", { method: "POST", body: JSON.stringify({ ok: true, userAgent: navigator.userAgent, results: out }) });
  } catch (e) {
    await fetch("/result", { method: "POST", body: JSON.stringify({ ok: false, error: String((e && e.stack) || e), results: out }) });
  }
})();
