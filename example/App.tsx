import { mount, signal, Text, View, windowSize, type JSX } from "nsh";
import {
  TimeSeriesChart,
  createChartController,
  createChartSync,
  createTimeSeries,
  nativeBackend,
  type Annotation,
} from "nsh-o11y";
import { randomWalkChunks, serviceMetrics } from "./data";

function Button(props: { label: string; onPress: () => void; active?: boolean; testID?: string }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityState={{ selected: !!props.active }}
      onPress={props.onPress}
      class={`rounded-md px-3 py-1.5 ${props.active ? "bg-primary" : "bg-secondary hover:bg-accent active:bg-accent"}`}
    >
      <Text class={`text-sm ${props.active ? "text-primary-foreground" : "text-secondary-foreground"}`}>{props.label}</Text>
    </View>
  );
}

function Panel(props: { children: JSX.Element; flex?: number }) {
  return (
    <View class="rounded-lg border border-border bg-card p-3" style={{ flex: props.flex ?? 1, minHeight: 180 }}>
      {props.children}
    </View>
  );
}

/**
 * Sizes for the big chart. NSH caps the JS heap at 256 MB, so ten million samples (160 MB of times and
 * values, more while arrays grow) only fit with the Rust backend, which keeps them out of JS.
 */
const sizes = () => (nativeBackend() ? [100_000, 1_000_000, 10_000_000, 50_000_000] : [100_000, 1_000_000, 2_000_000]);

function App() {
  // ---- Live service metrics, one sample every 100 ms, the last 5 minutes shown.
  const STEP = 100;
  const traffic = createTimeSeries({ series: 2, maxPoints: 60_000 });
  const latency = createTimeSeries({ series: 3, maxPoints: 60_000 });
  const cpu = createTimeSeries({ series: 4, maxPoints: 60_000 });
  const metrics = serviceMetrics();
  const annotations = signal<Annotation[]>([]);
  // Start with 5 minutes of history.
  let t = Date.now() - 300_000;
  const push = (time: number) => {
    const m = metrics.next(time);
    traffic.append(time, [m.rate, m.errors]);
    latency.append(time, [m.p50, m.p95, m.p99]);
    cpu.append(time, m.cpu);
  };
  for (; t < Date.now(); t += STEP) push(t);
  annotations.set([
    { time: Date.now() - 200_000, label: "deploy v2.14", color: "#6250d6" },
    { time: Date.now() - 120_000, end: Date.now() - 95_000, label: "incident #812", color: "#e34948" },
  ]);
  const live = signal(true);
  const timer = setInterval(() => {
    if (!live()) return;
    const now = Date.now();
    for (; t < now; t += STEP) push(t);
  }, STEP);
  void timer;

  // ---- A big one: the random walk, at a size picked below.
  const size = signal<number>(1_000_000);
  const big = createTimeSeries({ series: 1 });
  const loading = signal(false);
  let loadId = 0;
  /** Builds the walk in chunks, one turn of the event loop apart: the chart fills in as they come. */
  const loadBig = async (n: number) => {
    const id = ++loadId;
    size.set(n);
    loading.set(true);
    big.clear();
    await randomWalkChunks(n, (x, y) => {
      if (id === loadId) big.append(x, [y]);
    });
    if (id === loadId) loading.set(false);
  };
  loadBig(1_000_000);
  const bigChart = createChartController();

  const sync = createChartSync();
  const stats = signal("");
  big.subscribe(() => stats.set(`${big.length().toLocaleString()} samples`));

  const wide = () => windowSize().width >= 900;

  return (
    <View class="bg-background" style={{ flex: 1, padding: 16, gap: 12 }}>
      <View class="flex-row flex-wrap items-center gap-2">
        <Text class="text-lg font-semibold text-foreground">Checkout service</Text>
        <Text class="text-sm text-muted-foreground" testID="backend">
          {nativeBackend() ? "Rust backend" : "TypeScript backend"}
        </Text>
        <View style={{ flex: 1 }} />
        <Button label={live() ? "Pause" : "Resume"} onPress={() => live.update((v) => !v)} testID="live" />
        <Button label="Reset zoom" onPress={() => sync.reset()} testID="reset" />
      </View>
      <View style={{ flex: 1, flexDirection: wide() ? "row" : "column", gap: 12 }}>
        <Panel>
          <TimeSeriesChart
            testID="traffic"
            title="Requests"
            data={traffic}
            series={[{ label: "requests", fill: 0.1 }, { label: "errors", color: "#e34948" }]}
            unit="reqps"
            softMin={0}
            window={300_000}
            annotations={annotations()}
            sync={sync}
            style={{ flex: 1 }}
          />
        </Panel>
        <Panel>
          <TimeSeriesChart
            testID="latency"
            title="Latency"
            data={latency}
            series={[{ label: "p50" }, { label: "p95" }, { label: "p99", width: 1 }]}
            unit="ms"
            softMin={0}
            window={300_000}
            thresholds={[{ value: 250, label: "SLO 250 ms", color: "#e34948" }]}
            annotations={annotations()}
            sync={sync}
            style={{ flex: 1 }}
          />
        </Panel>
      </View>
      <View style={{ flex: 1, flexDirection: wide() ? "row" : "column", gap: 12 }}>
        <Panel>
          <TimeSeriesChart
            testID="cpu"
            title="CPU by host"
            data={cpu}
            series={[{ label: "web-1" }, { label: "web-2" }, { label: "web-3" }, { label: "web-4" }]}
            unit="percent"
            yMin={0}
            yMax={100}
            window={300_000}
            sync={sync}
            style={{ flex: 1 }}
          />
        </Panel>
        <Panel flex={wide() ? 1.4 : 1}>
          <View class="flex-row flex-wrap items-center gap-2" style={{ marginBottom: 6 }}>
            <Text class="text-sm font-medium text-foreground">Random walk</Text>
            <Each of={sizes()}>
              {(n) => (
                <Button
                  label={n() >= 1e6 ? `${n() / 1e6}M` : `${n() / 1e3}k`}
                  active={size() === n()}
                  onPress={() => loadBig(n())}
                  testID={`size-${n()}`}
                />
              )}
            </Each>
            <Text class="text-xs text-muted-foreground" testID="stats">
              {loading() ? `loading… ${big.length().toLocaleString()}` : stats()}
            </Text>
          </View>
          <TimeSeriesChart
            testID="big"
            data={big}
            series={[{ label: "value" }]}
            unit="short"
            controller={bigChart}
            style={{ flex: 1 }}
          />
        </Panel>
      </View>
    </View>
  );
}

mount(App);
