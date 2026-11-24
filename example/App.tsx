import { List, computed, mount, signal, Text, View, windowSize, type JSX } from "nsh";
import {
  FlameGraph,
  LogStore,
  LogView,
  TimeSeriesChart,
  TraceModel,
  TraceWaterfall,
  createChartController,
  createChartSync,
  createTimeSeries,
  formatValue,
  nativeBackend,
  profileFromFolded,
  topFunctions,
  type Annotation,
  type Span,
} from "nsh-o11y";
import { randomWalkChunks, serviceMetrics } from "./data";
import { checkoutProfile, serviceLogs } from "./telemetry";

type Tab = "metrics" | "logs" | "traces" | "profiles";
const TABS: { id: Tab; label: string }[] = [
  { id: "metrics", label: "Metrics" },
  { id: "logs", label: "Logs" },
  { id: "traces", label: "Traces" },
  { id: "profiles", label: "Profiles" },
];

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
  // Logs from the same 5 minutes, and the traces they link to.
  const logSource = serviceLogs(11, [incident]);
  const logs = new LogStore({ maxEntries: 50_000 });
  logs.append(logSource.next(start - 300_000, start));
  let logT = start;
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
    if (++ticks % 5 === 0) {
      now.set(last);
      const lines = logSource.next(logT, at);
      logT = at;
      if (lines.length) logs.append(lines);
    }
  }, STEP);
  void timer;

  // ---- Traces: the newest ones the logs link to, one open in the waterfall.
  const tab = signal<Tab>("metrics");
  const traceList = signal(logSource.recent(40));
  const firstError = traceList().find((tr) => tr.spans.some((s) => s.status === "error")) ?? traceList()[0];
  const traceId = signal<string | null>(firstError?.traceId ?? null);
  const span = signal<Span | null>(null);
  const openTrace = (id: string) => {
    traceList.set(logSource.recent(40));
    traceId.set(id);
    span.set(null);
    tab.set("traces");
  };
  const trace = computed(() => {
    const id = traceId();
    const spans = id ? logSource.trace(id) : undefined;
    return spans ? new TraceModel(spans) : null;
  });

  // ---- A CPU profile.
  const profile = profileFromFolded(checkoutProfile());
  const top = topFunctions(profile, 14);
  const highlight = signal("");

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

  const logsPage = () => (
    <Panel>
      <LogView
        testID="logs"
        title="Logs"
        data={logs}
        window={300_000}
        onTraceClick={(id) => openTrace(id)}
        style={{ flex: 1 }}
      />
    </Panel>
  );

  const tracesPage = () => (
    <View style={{ flex: 1, flexDirection: "row", gap: 14 }}>
      <View class="rounded-xl border border-border bg-card py-2" style={{ width: 300 }}>
        <Text class="text-sm font-medium text-foreground" style={{ paddingHorizontal: 12, paddingBottom: 6 }}>
          Recent traces
        </Text>
        <List each={traceList()} keyExtractor={(tr) => tr.traceId} style={{ flex: 1 }} testID="trace-list">
          {(tr, i) => {
            const root = () => tr().spans.find((s) => !s.parentId) ?? tr().spans[0];
            const bad = () => tr().spans.some((s) => s.status === "error");
            return (
              <View
                role="button"
                testID={`trace-${i()}`}
                accessibilityState={{ selected: traceId() === tr().traceId }}
                onPress={() => {
                  traceId.set(tr().traceId);
                  span.set(null);
                }}
                class={`px-3 py-1.5 ${traceId() === tr().traceId ? "bg-accent" : "hover:bg-accent"}`}
                style={{ gap: 1 }}
              >
                <View class="flex-row items-center" style={{ gap: 6 }}>
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: bad() ? "#e34948" : "#1baf7a" }} />
                  <Text class="text-xs text-foreground" style={{ flex: 1, numberOfLines: 1 }}>
                    {root().name}
                  </Text>
                  <Text class="text-xs text-muted-foreground" style={{ fontVariant: ["tabular-nums"] }}>
                    {formatValue(root().duration, "ms")}
                  </Text>
                </View>
                <Text class="font-mono text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>
                  {`${tr().traceId.slice(0, 16)} · ${tr().spans.length} spans`}
                </Text>
              </View>
            );
          }}
        </List>
      </View>
      <View style={{ flex: 1, gap: 14 }}>
        <Panel>
          <Text class="text-sm font-medium text-foreground" style={{ marginBottom: 6 }}>
            {traceId() ? `Trace ${traceId()!.slice(0, 16)}…` : "Trace"}
          </Text>
          {trace() ? (
            <TraceWaterfall testID="waterfall" spans={trace()!} onSelect={(s) => span.set(s)} style={{ flex: 1 }} />
          ) : (
            <Text class="text-sm text-muted-foreground">No trace selected</Text>
          )}
        </Panel>
        <View class="rounded-xl border border-border bg-card px-4 py-3" style={{ height: 170, gap: 3 }} testID="span-details">
          {span() ? (
            <View style={{ gap: 3 }}>
              <Text class="text-sm font-medium text-foreground">{`${span()!.name} · ${span()!.service}`}</Text>
              <Text class="text-xs text-muted-foreground">
                {`${formatValue(span()!.duration, "ms")} · ${span()!.kind ?? "internal"} · ${span()!.status ?? "unset"} · span ${span()!.spanId}`}
              </Text>
              <Each of={Object.entries(span()!.attributes ?? {})}>
                {(kv) => (
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <Text class="font-mono text-xs text-muted-foreground" style={{ width: 160 }}>
                      {kv()[0]}
                    </Text>
                    <Text class="font-mono text-xs text-foreground" style={{ flex: 1 }}>
                      {String(kv()[1])}
                    </Text>
                  </View>
                )}
              </Each>
            </View>
          ) : (
            <Text class="text-sm text-muted-foreground">Select a span to see its attributes</Text>
          )}
        </View>
      </View>
    </View>
  );

  const profilesPage = () => (
    <View style={{ flex: 1, flexDirection: wide() ? "row" : "column", gap: 14 }}>
      <Panel>
        <Text class="text-sm font-medium text-foreground" style={{ marginBottom: 6 }}>
          {`CPU profile · ${profile.value.toLocaleString()} samples`}
        </Text>
        <FlameGraph testID="flame" profile={profile} highlight={highlight()} style={{ flex: 1 }} />
      </Panel>
      <View class="rounded-xl border border-border bg-card px-4 py-3" style={{ width: wide() ? 340 : undefined, gap: 2 }}>
        <View class="flex-row" style={{ gap: 8, marginBottom: 4 }}>
          <Text class="text-sm font-medium text-foreground" style={{ flex: 1 }}>
            Top functions
          </Text>
          <Text class="text-xs text-muted-foreground" style={{ width: 52, textAlign: "right" }}>
            self
          </Text>
          <Text class="text-xs text-muted-foreground" style={{ width: 52, textAlign: "right" }}>
            total
          </Text>
        </View>
        <Each of={top}>
          {(f, i) => (
            <View
              role="button"
              testID={`top-${i()}`}
              accessibilityState={{ selected: highlight() === f().name }}
              onPress={() => highlight.set(highlight() === f().name ? "" : f().name)}
              class={`rounded px-1 py-1 ${highlight() === f().name ? "bg-accent" : "hover:bg-accent"}`}
              style={{ flexDirection: "row", gap: 8, alignItems: "center" }}
            >
              <Text class="font-mono text-xs text-foreground" style={{ flex: 1, numberOfLines: 1, textOverflow: "ellipsis-start" }}>
                {f().name}
              </Text>
              <Text class="text-xs text-foreground" style={{ width: 52, textAlign: "right", fontVariant: ["tabular-nums"] }}>
                {`${((f().self / profile.value) * 100).toFixed(1)}%`}
              </Text>
              <Text class="text-xs text-muted-foreground" style={{ width: 52, textAlign: "right", fontVariant: ["tabular-nums"] }}>
                {`${((f().total / profile.value) * 100).toFixed(1)}%`}
              </Text>
            </View>
          )}
        </Each>
      </View>
    </View>
  );

  return (
    <View class="bg-background" style={{ flex: 1, padding: 20, gap: 14 }}>
      <View class="flex-row flex-wrap items-center gap-3">
        <View style={{ gap: 2 }}>
          <Text class="text-xl font-semibold text-foreground">Checkout service</Text>
          <Text class="text-xs text-muted-foreground" testID="backend">
            {`production · last 5 minutes · ${live() ? "live" : "paused"} · ${nativeBackend() ? "Rust" : "TypeScript"} backend`}
          </Text>
        </View>
        <View role="tablist" class="flex-row rounded-lg bg-secondary p-1" style={{ gap: 2, marginLeft: 12 }}>
          <Each of={TABS}>
            {(item) => (
              <View
                role="tab"
                testID={`tab-${item().id}`}
                accessibilityState={{ selected: tab() === item().id }}
                onPress={() => {
                  if (item().id === "traces") traceList.set(logSource.recent(40));
                  tab.set(item().id);
                }}
                class={`rounded-md px-3 py-1 ${tab() === item().id ? "bg-background" : "hover:bg-accent"}`}
              >
                <Text class={`text-sm ${tab() === item().id ? "text-foreground font-medium" : "text-muted-foreground"}`}>{item().label}</Text>
              </View>
            )}
          </Each>
        </View>
        <View style={{ flex: 1 }} />
        <Button label={live() ? "Pause" : "Resume"} onPress={() => live.update((v) => !v)} testID="live" />
        {tab() === "metrics" ? <Button label="Reset zoom" onPress={() => sync.reset()} testID="reset" /> : null}
      </View>
      {tab() === "logs" ? logsPage() : tab() === "traces" ? tracesPage() : tab() === "profiles" ? profilesPage() : metricsPage()}
    </View>
  );

  function metricsPage() {
    return (
    <View style={{ flex: 1, gap: 14 }}>
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
}

mount(App);
