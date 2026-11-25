/**
 * Pictures of the dashboard on a real host, to look at: `nsh test example/screenshot.test.tsx --target windows`
 * (or macos, linux). Headless runs draw nothing, so there it only checks the app opens.
 */
import { open, test } from "nsh/test";

test("screenshots: at rest, hovering, zoomed", async () => {
  const app = await open("./App.tsx", { width: 1240, height: 860 });
  await app.waitFor("id:latency-plot");
  await app.wait(1500);
  const shot = async (name: string) => {
    try {
      await app.screenshot(`../bench/results/${name}.png`);
    } catch {
      // Headless: nothing drawn.
    }
  };
  await shot("dashboard");
  await app.press("id:latency-heat");
  await app.wait(500);
  await shot("dashboard-heatmap");
  await app.press("id:latency-lines");
  await app.drag("id:big-plot", { x: 200, y: 0 });
  await app.wait(500);
  await shot("dashboard-zoomed");
}, 60_000);

test("screenshots: logs, a trace, a profile", async () => {
  const app = await open("./App.tsx", { width: 1240, height: 860 });
  await app.waitFor("id:tab-logs");
  const shot = async (name: string) => {
    try {
      await app.screenshot(`../bench/results/${name}.png`);
    } catch {
      // Headless: nothing drawn.
    }
  };
  await app.press("id:tab-logs");
  await app.wait(1000);
  await shot("logs");
  await app.press("id:tab-traces");
  await app.wait(500);
  await app.drag("id:waterfall-plot", { x: 0, y: 0 });
  await app.drag("id:waterfall-plot", { x: 160, y: 0 }); // zoom: the overview marks the range
  await app.wait(300);
  await shot("traces");
  await app.press("id:trace-compare");
  await app.wait(400);
  await shot("traces-compare");
  await app.press("id:trace-waterfall");
  await app.press("id:tab-profiles");
  await app.wait(500);
  await shot("profiles");
  await app.press("id:compare");
  await app.wait(500);
  await shot("profiles-diff");
  await app.press("id:view-sandwich");
  await app.press("text:runtime.mallocgc");
  await app.wait(500);
  await shot("profiles-sandwich");
}, 60_000);
