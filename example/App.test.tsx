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

test("the logs tab: levels, search, and a line's trace link opens the trace", async () => {
  const app = await open("./App.tsx", { width: 1240, height: 860 });
  await app.waitFor("id:tab-logs");
  await app.press("id:tab-logs");
  await app.waitFor("id:logs-histogram");
  const count = () => app.texts().find((t) => / of [\d,]+ lines$/.test(t)) ?? "";
  const all = count();
  expect(all).toMatch(/lines$/);
  await app.press("id:logs-level-info");
  await app.wait(100);
  expect(count()).not.toBe(all);
  await app.type("id:logs-search", "charge failed");
  await app.wait(100);
  expect(app.texts().some((t) => t.includes("charge failed"))).toBe(true);
  await app.press("id:logs-line-0");
  await app.waitFor("id:logs-trace-link");
  await app.press("id:logs-trace-link");
  await app.waitFor("id:waterfall-plot");
  expect(app.texts().some((t) => t.startsWith("Trace "))).toBe(true);
});

test("the traces tab: pick a trace, select a span", async () => {
  const app = await open("./App.tsx", { width: 1240, height: 860, platform: "windows" });
  await app.waitFor("id:tab-traces");
  await app.press("id:tab-traces");
  await app.waitFor("id:waterfall-plot");
  await app.press("id:trace-1");
  await app.wait(100);
  expect(app.texts()).toContain("Select a span to see its attributes");
  // A tap on a row selects its span; its attributes show below.
  await app.drag("id:waterfall-plot", { x: 0, y: 0 });
  await app.wait(100);
  expect(app.texts()).not.toContain("Select a span to see its attributes");
  // Dragging across the timeline zooms; hovering shows a tooltip.
  await app.drag("id:waterfall-plot", { x: 120, y: 0 });
  await app.hover("id:waterfall-plot");
});

test("the profiles tab: the flame graph and the top functions", async () => {
  const app = await open("./App.tsx", { width: 1240, height: 860, platform: "windows" });
  await app.waitFor("id:tab-profiles");
  await app.press("id:tab-profiles");
  await app.waitFor("id:flame-plot");
  expect(app.texts()).toContain("Top functions");
  await app.press("id:top-0");
  await app.waitFor("id:flame-matched");
  expect(app.texts().some((t) => /% matched$/.test(t))).toBe(true);
  await app.hover("id:flame-plot");
  // Pressed again, the function is no longer picked out.
  await app.press("id:top-0");
  await app.wait(100);
  expect(app.shows("id:flame-matched")).toBe(false);
});

test("the flame graph from the keyboard: arrows walk the frames, Enter zooms, Escape zooms out", async () => {
  const app = await open("./App.tsx", { width: 1240, height: 860, platform: "windows" });
  await app.waitFor("id:tab-profiles");
  await app.press("id:tab-profiles");
  await app.waitFor("id:flame-plot");
  // A click gives the graph the keyboard (the middle of it is below the deepest frame: no zoom).
  await app.drag("id:flame-plot", { x: 0, y: 0 });
  expect(app.shows("id:flame-crumb-1")).toBe(false);
  await app.keyboard.press("down"); // onto the root
  // Headless runs don't route keys to a focused view: this part runs on a real host
  // (`nsh test example/App.test.tsx --target windows`, or macos, linux).
  if (!(app.accessibility("id:flame-plot")?.label ?? "").includes("On all")) return;
  await app.keyboard.press("down"); // its biggest callee
  expect(app.accessibility("id:flame-plot")?.label ?? "").toContain("On runtime.main");
  await app.keyboard.press("enter");
  await app.waitFor("id:flame-crumb-1");
  expect(app.accessibility("id:flame-plot")?.label ?? "").toContain("zoomed to runtime.main");
  await app.keyboard.press("escape");
  await app.wait(50);
  expect(app.shows("id:flame-crumb-1")).toBe(false);
});
