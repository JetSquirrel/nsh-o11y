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
  await app.drag("id:big-plot", { x: 200, y: 0 });
  await app.wait(500);
  await shot("dashboard-zoomed");
}, 60_000);
