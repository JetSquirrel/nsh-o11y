/** Dark-mode pictures of every tab, to look at: `nsh test example/dark.test.tsx --target windows`. */
import { open, test } from "nsh/test";

test("screenshots in dark mode", async () => {
  const app = await open("./App.tsx", { width: 1240, height: 860, colorScheme: "dark" });
  await app.waitFor("id:latency-heat");
  const shot = async (name: string) => {
    try {
      await app.screenshot(`../bench/results/dark-${name}.png`);
    } catch {
      // Headless: nothing drawn.
    }
  };
  await app.wait(800);
  await shot("metrics");
  await app.press("id:latency-heat");
  await app.wait(400);
  await shot("heatmap");
  await app.press("id:tab-logs");
  await app.wait(600);
  await shot("logs");
  await app.press("id:tab-traces");
  await app.wait(400);
  await app.drag("id:waterfall-plot", { x: 0, y: 0 });
  await app.drag("id:waterfall-plot", { x: 160, y: 0 });
  await app.wait(300);
  await shot("traces");
  await app.press("id:tab-profiles");
  await app.wait(400);
  await shot("profiles");
  await app.press("id:compare");
  await app.wait(300);
  await shot("profiles-diff");
}, 90_000);
