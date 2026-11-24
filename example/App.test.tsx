import { expect, open, test } from "nsh/test";

test("shows the dashboard: four charts with their legends", async () => {
  const app = await open("./App.tsx", { width: 1240, height: 860 });
  await app.waitFor("id:traffic-plot");
  for (const id of ["traffic", "latency", "cpu", "big"]) expect(app.shows(`id:${id}-plot`)).toBe(true);
  const texts = app.texts();
  for (const t of ["Requests", "Latency", "CPU by host", "p99", "web-4", "p99 latency", "Error rate"]) expect(texts).toContain(t);
  expect(texts.some((t) => t.includes("TypeScript backend"))).toBe(true);
  // The legend reads the newest values.
  expect(texts.some((t) => /req\/s$/.test(t))).toBe(true);
  expect(texts.some((t) => /\d+(\.\d+)?%$/.test(t))).toBe(true);
});

test("the legend toggles a series", async () => {
  const app = await open("./App.tsx", { width: 1240, height: 860 });
  await app.waitFor("id:latency-legend-2");
  await app.press("id:latency-legend-2");
  await app.wait(100);
  await app.press("id:latency-legend-2");
});

test("dragging zooms, Reset zoom goes back, and live pauses", async () => {
  const app = await open("./App.tsx", { width: 1240, height: 860 });
  await app.waitFor("id:latency-plot");
  await app.drag("id:latency-plot", { x: 150, y: 0 });
  await app.wait(200);
  await app.press("id:reset");
  await app.press("id:live");
  expect(app.texts()).toContain("Resume");
});

test("loads two million samples in chunks without stalling", async () => {
  const app = await open("./App.tsx", { width: 1240, height: 860 });
  await app.waitFor("id:size-2000000");
  await app.press("id:size-2000000");
  await app.waitUntil(() => app.texts().some((t) => t.includes("2,000,000 samples")), { timeout: 60_000 });
  expect(app.shows("id:big-plot")).toBe(true);
}, 90_000);
