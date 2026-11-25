import { expect, open, test } from "nsh/test";

test("a legend on data that never changes is written after the layout: its axis's unit and precision", async () => {
  const app = await open("./StaticChart.tsx", { width: 800, height: 600 });
  await app.waitFor("id:static-requests-plot");
  await app.wait(100);
  const texts = app.texts();
  // Each legend entry: its label, then its newest value. Made before the layout and the chart's options, it read
  // "1.28k" and "49.2": the default unit, and a precision from no axis.
  const value = (label: string) => texts[texts.indexOf(label) + 1] ?? "";
  expect(value("requests")).toMatch(/^[\d.,]+k? req\/s$/);
  // Ticks 10 ms apart: a tenth of that is whole milliseconds.
  expect(value("p50")).toMatch(/^\d+ ms$/);
});
