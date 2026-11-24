import { mount, signal, Text, View, windowSize, type JSX } from "nsh";
import {
  TimeSeriesChart,
  createChartController,
  createChartSync,
  createTimeSeries,
  formatValue,
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

/** A card for one chart. Panels in a row share it evenly, whatever their content measures. */
function Panel(props: { children: JSX.Element }) {
  return (
    <View
      class="rounded-xl border border-border bg-card px-4 py-3"
      style={{ flex: 1, flexBasis: 0, minWidth: 0, minHeight: 200 }}
    >
      {props.children}
    </View>
  );
}

/** A headline number: what the newest sample says, in red when it is past its limit. */
function Stat(props: { label: string; value: string; detail?: string; bad?: boolean; testID?: string }) {
  return (
    <View
      class="rounded-xl border border-border bg-card px-4 py-3"
      style={{ flex: 1, flexBasis: 0, minWidth: 150, gap: 2 }}
      testID={props.testID}
    >
      <Text class="text-xs text-muted-foreground">{props.label}</Text>
      <View class="flex-row items-baseline gap-2">
        <Text
          class={`text-2xl font-semibold ${props.bad ? "text-destructive" : "text-foreground"}`}
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {props.value}
        </Text>
        {props.detail ? <Text class="text-xs text-muted-foreground">{props.detail}</Text> : null}
      </View>
    </View>
  );
}

/**
 * Sizes for the big chart. NSH caps the JS heap at 256 MB, so ten million samples (160 MB of times and
 * values, more while arrays grow) only fit with the Rust backend, which keeps them out of JS.
 */
const sizes = () => (nativeBackend() ? [100_000, 1_000_000, 10_000_000, 50_000_000] : [100_000, 1_000_000, 2_000_000]);

const SLO = 250;

function App() {
  // ---- Live service metrics, one sample every 100 ms, the last 5 minutes shown.
  const STEP = 100;
  const traffic = createTimeSeries({ series: 2, maxPoints: 60_000 });
  const latency = createTimeSeries({ series: 3, maxPoints: 60_000 });
  const cpu = createTimeSeries({ series: 4, maxPoints: 60_000 });
  // Start with 5 minutes of history: a deploy, and an incident a minute later, as the annotations say.
  const start = Date.now();
  const incident: [number, number] = [start - 120_000, start - 95_000];
  const metrics = serviceMetrics(7, [incident]);
  const annotations = signal<Annotation[]>([]);
  let t = start - 300_000;
  let last = metrics.next(t);
  const push = (time: number) => {
    const m = (last = metrics.next(time));
    traffic.append(time, [m.rate, m.errors]);
    latency.append(time, [m.p50, m.p95, m.p99]);
    cpu.append(time, m.cpu);
  };
  for (; t < start; t += STEP) push(t);
  annotations.set([
    { time: start - 200_000, label: "deploy v2.14", color: "#6250d6" },
    { time: incident[0], end: incident[1], label: "incident #812", color: "#e34948" },
  ]);
  const live = signal(true);
  // The headline numbers refresh twice a second: faster only flickers.
  const now = signal(last);
  let ticks = 0;
  const timer = setInterval(() => {
    if (!live()) return;
    const at = Date.now();
    for (; t < at; t += STEP) push(t);
    if (++ticks % 5 === 0) now.set(last);
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
  const row = () => ({ flex: 1, flexBasis: 0, flexDirection: wide() ? ("row" as const) : ("column" as const), gap: 14 });
  const errorRate = () => now().errors / now().rate;
  const cpuMean = () => now().cpu.reduce((a, b) => a + b, 0) / now().cpu.length;

  return (
    <View class="bg-background" style={{ flex: 1, padding: 20, gap: 14 }}>
      <View class="flex-row flex-wrap items-center gap-3">
        <View style={{ gap: 2 }}>
          <Text class="text-xl font-semibold text-foreground">Checkout service</Text>
          <Text class="text-xs text-muted-foreground" testID="backend">
            {`production · last 5 minutes · ${live() ? "live" : "paused"} · ${nativeBackend() ? "Rust" : "TypeScript"} backend`}
          </Text>
        </View>
        <View style={{ flex: 1 }} />
        <Button label={live() ? "Pause" : "Resume"} onPress={() => live.update((v) => !v)} testID="live" />
        <Button label="Reset zoom" onPress={() => sync.reset()} testID="reset" />
      </View>
      <View class="flex-row flex-wrap" style={{ gap: 14 }}>
        <Stat label="Requests" value={formatValue(now().rate, "reqps")} testID="stat-rate" />
        <Stat
          label="Error rate"
          value={`${(errorRate() * 100).toFixed(2)}%`}
          detail={formatValue(now().errors, "reqps")}
          bad={errorRate() > 0.01}
        />
        <Stat label="p99 latency" value={formatValue(now().p99, "ms")} detail={`SLO ${SLO} ms`} bad={now().p99 > SLO} />
        <Stat
          label="CPU, mean of 4 hosts"
          value={`${cpuMean().toFixed(0)}%`}
          detail={`max ${Math.max(...now().cpu).toFixed(0)}%`}
        />
      </View>
      <View style={row()}>
        <Panel>
          <TimeSeriesChart
            testID="traffic"
            title="Requests"
            data={traffic}
            series={[
              { label: "requests", fill: 0.06, width: 1.25 },
              { label: "errors", color: "#e34948", fill: 0.15, width: 1.25 },
            ]}
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
            series={[{ label: "p50", width: 1.25 }, { label: "p95", width: 1.25 }, { label: "p99", width: 1.25 }]}
            unit="ms"
            softMin={0}
            window={300_000}
            thresholds={[{ value: SLO, label: `SLO ${SLO} ms`, color: "#e34948" }]}
            annotations={annotations()}
            sync={sync}
            style={{ flex: 1 }}
          />
        </Panel>
      </View>
      <View style={row()}>
        <Panel>
          <TimeSeriesChart
            testID="cpu"
            title="CPU by host"
            data={cpu}
            series={["web-1", "web-2", "web-3", "web-4"].map((label) => ({ label, width: 1.25 }))}
            unit="percent"
            yMin={0}
            yMax={100}
            window={300_000}
            sync={sync}
            style={{ flex: 1 }}
          />
        </Panel>
        <Panel>
          <View class="flex-row flex-wrap items-center gap-2" style={{ marginBottom: 6 }}>
            <Text class="text-sm font-medium text-foreground">Random walk</Text>
            <Text class="text-xs text-muted-foreground" testID="stats">
              {loading() ? `loading… ${big.length().toLocaleString()}` : stats()}
            </Text>
            <View style={{ flex: 1 }} />
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
          </View>
          <TimeSeriesChart
            testID="big"
            data={big}
            series={[{ label: "value", width: 1.25 }]}
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
