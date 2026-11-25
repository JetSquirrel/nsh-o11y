/**
 * A chart on data that never changes, as a query's result is: for `static.test.tsx`. Its legend's values were
 * made before the first layout and kept two decimals ("778.04 req/s") until something else redrew them.
 */
import { mount, View } from "nsh";
import { TimeSeriesChart } from "nsh-o11y";

const x = Array.from({ length: 300 }, (_, i) => 1_700_000_000_000 + i * 1000);
const requests = x.map((_, i) => 1000 + Math.sin(i / 20) * 300 + 78.04123);
const latency = x.map((_, i) => 44.78123 + Math.sin(i / 15) * 5);

function App() {
  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <TimeSeriesChart testID="static-requests" data={{ x, ys: [requests] }} series={[{ label: "requests" }]} unit="reqps" softMin={0} style={{ flex: 1 }} />
      <TimeSeriesChart testID="static-latency" data={{ x, ys: [latency] }} series={[{ label: "p50" }]} unit="ms" softMin={0} style={{ flex: 1 }} />
    </View>
  );
}

mount(App);
