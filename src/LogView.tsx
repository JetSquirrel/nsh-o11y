/**
 * `<LogView>`: a log explorer. A toolbar of level toggles (with counts) and a search box, a histogram of
 * log volume per level over time (drag across it to narrow the list to a range, double-click to widen it
 * again), and a virtualized list of lines, newest first. Pressing a line opens its attributes and, when it
 * carries a trace id, a link to the trace.
 */
import {
  Canvas,
  List,
  Path2D,
  Text,
  View,
  cleanup,
  computed,
  effect,
  signal,
  untracked,
  type GestureResponderEvent,
  type MouseEvent,
  type ViewStyle,
} from "nsh";
import { Input } from "nsh/base";
import { LOG_LEVEL_COLORS, LOG_LEVELS, LogStore, type LogEntry, type LogLevel } from "./logs";
import { LogVolumeEngine, renderLogVolume, renderLogVolumeOverlay } from "./logvolume";
import { fontOf, measureCached, type Ctx2D } from "./render";
import { formatTime, formatTimeFull, type TimeZone } from "./scale";
import { resolveTheme } from "./theme";
import type { ChartColors, ChartTheme } from "./types";
import { withAlpha } from "./palette";

export interface LogViewProps {
  /** The lines: a `LogStore` (appended to live) or an array. */
  data: LogStore | readonly LogEntry[];
  title?: string;
  /** The levels shown at first. Default all. */
  levels?: LogLevel[];
  /** The search text at first. */
  search?: string;
  /** Level toggles and the search box. Default true. */
  toolbar?: boolean;
  /** The volume histogram. Default true. */
  histogram?: boolean;
  /** Its height in points. Default 96. */
  histogramHeight?: number;
  /** Newest line first (the default) or oldest first. */
  order?: "newest" | "oldest";
  /** Live: the histogram shows the last `window` ms. Default: all the lines. */
  window?: number;
  timeZone?: TimeZone;
  /** Colors per level, over the defaults. */
  levelColors?: Partial<Record<LogLevel, string>>;
  colors?: ChartColors;
  fontFamily?: string;
  fontSize?: number;
  /** A line was opened (or closed: null). */
  onSelect?: (entry: LogEntry | null) => void;
  /** The trace link of an opened line was pressed. */
  onTraceClick?: (traceId: string, entry: LogEntry) => void;
  /** The list was narrowed to a range on the histogram, or widened again (null). */
  onRangeChange?: (range: [number, number] | null) => void;
  style?: ViewStyle;
  class?: string;
  testID?: string;
}

const PATH = (d: string) => new Path2D(d);
const DOUBLE_CLICK_MS = 350;

export function LogView(props: LogViewProps) {
  const store = computed<LogStore>(() => {
    const d = props.data;
    return d instanceof LogStore ? d : untracked(() => LogStore.from(d as LogEntry[]));
  });
  const shown = signal<ReadonlySet<LogLevel>>(new Set(props.levels ?? LOG_LEVELS));
  const text = signal(props.search ?? "");
  const range = signal<[number, number] | null>(null);
  const selected = signal<LogEntry | null>(null);
  // Bumped at most once a frame while lines stream in.
  const version = signal(0);
  const theme = computed<ChartTheme>(() => resolveTheme(props.colors, props.fontFamily, props.fontSize));
  const colors = computed(() => ({ ...LOG_LEVEL_COLORS, ...props.levelColors }));

  let raf: number | undefined;
  effect(() => {
    const st = store();
    untracked(() => version.update((n) => n + 1));
    const off = st.subscribe(() => {
      if (raf === undefined)
        raf = requestAnimationFrame(() => {
          raf = undefined;
          version.update((n) => n + 1);
        });
    });
    cleanup(off);
  });
  cleanup(() => {
    if (raf !== undefined) cancelAnimationFrame(raf);
  });

  const levelList = () => LOG_LEVELS.filter((l) => shown().has(l));
  const filter = () => {
    const r = range();
    const all = shown().size === LOG_LEVELS.length;
    return { levels: all ? undefined : levelList(), text: text(), from: r?.[0], to: r?.[1] };
  };

  // The last rows made, kept so that lines streaming in only add rows instead of making them all again.
  let made: { store: LogStore; key: string; epoch: number; n: number; rows: LogEntry[] } | null = null;
  const rows = computed<LogEntry[]>(() => {
    version();
    const st = store();
    const f = filter();
    const newest = (props.order ?? "newest") === "newest";
    const key = `${newest}|${f.levels?.join(",") ?? "*"}|${f.text}|${f.from ?? ""}|${f.to ?? ""}`;
    const idx = st.query(f);
    const from = made && made.store === st && made.key === key && made.epoch === st.epoch && idx.length >= made.n ? made.n : 0;
    const add = new Array<LogEntry>(idx.length - from);
    for (let i = from; i < idx.length; i++) add[newest ? idx.length - 1 - i : i - from] = st.get(idx[i]);
    // Joining arrays is native: cheap next to building one entry by entry.
    const out = from === 0 ? add : newest ? add.concat(made!.rows) : made!.rows.concat(add);
    made = { store: st, key, epoch: st.epoch, n: idx.length, rows: out };
    return out;
  });

  const counts = computed(() => {
    version();
    const r = range();
    return store().levelCounts({ text: text(), from: r?.[0], to: r?.[1] });
  });

  const setRange = (r: [number, number] | null) => {
    range.set(r);
    props.onRangeChange?.(r);
  };

  const toggleLevel = (l: LogLevel) => {
    const next = new Set(shown());
    if (next.has(l)) next.delete(l);
    else next.add(l);
    shown.set(next);
  };

  const select = (e: LogEntry) => {
    const next = selected() === e ? null : e;
    selected.set(next);
    props.onSelect?.(next);
  };

  // ---- The histogram

  const vol = new LogVolumeEngine();
  const overlay = signal(0);
  let gesture: { origin: number; originY: number; start: number; moved: boolean } | null = null;
  let lastTap = 0;

  const viewRange = (): [number, number] => {
    const ext = store().extent();
    if (!ext) {
      const now = Date.now();
      return [now - (props.window ?? 300_000), now];
    }
    return props.window ? [ext[1] - props.window, ext[1]] : ext;
  };

  const onGrant = (e: GestureResponderEvent) => {
    gesture = { origin: e.pageX - e.locationX, originY: e.pageY - e.locationY, start: e.locationX, moved: false };
    return true;
  };
  const onMove = (e: GestureResponderEvent) => {
    const g = gesture;
    if (!g) return;
    const x = e.pageX - g.origin;
    if (!g.moved && Math.abs(x - g.start) > 4) g.moved = true;
    if (g.moved) {
      vol.selection = { from: g.start, to: x };
      vol.hover = vol.bucketAt(x);
      overlay.update((n) => n + 1);
    }
  };
  const onRelease = (e: GestureResponderEvent) => {
    const g = gesture;
    gesture = null;
    if (!g) return;
    if (g.moved) {
      const r = vol.endSelection();
      if (r) setRange(r);
      overlay.update((n) => n + 1);
      return;
    }
    const now = Date.now();
    if (now - lastTap < DOUBLE_CLICK_MS) {
      lastTap = 0;
      setRange(null);
      return;
    }
    lastTap = now;
    // A tap on a bar narrows the list to its bucket.
    const k = vol.bucketAt(e.pageX - g.origin);
    const h = vol.hist;
    if (k >= 0 && h) setRange([h.t0 + k * h.step, h.t0 + (k + 1) * h.step - 1e-6]);
  };
  const onTerminate = () => {
    gesture = null;
    vol.selection = null;
    overlay.update((n) => n + 1);
  };
  const onMouseMove = (e: MouseEvent) => {
    if (gesture) return;
    const k = vol.inPlot(e.position.x, e.position.y) ? vol.bucketAt(e.position.x) : -1;
    vol.hoverY = e.position.y;
    if (k !== vol.hover || k >= 0) {
      vol.hover = k;
      overlay.update((n) => n + 1);
    }
  };
  const onMouseLeave = () => {
    if (vol.hover < 0) return;
    vol.hover = -1;
    overlay.update((n) => n + 1);
  };

  const histLabel = () => {
    const c = counts();
    const total = LOG_LEVELS.reduce((a, l) => a + c[l], 0);
    const r = range();
    const tz = props.timeZone ?? "local";
    const span = r ? `${formatTimeFull(r[0], r[1] - r[0], tz)} to ${formatTimeFull(r[1], r[1] - r[0], tz)}` : "all time";
    return `Log volume, ${span}: ${total.toLocaleString()} lines, ${c.error + c.fatal} errors, ${c.warn} warnings`;
  };

  const tz = () => props.timeZone ?? "local";
  const total = () => {
    version();
    return store().length();
  };

  return (
    <View style={{ flexDirection: "column", gap: 8, ...props.style }} class={props.class} testID={props.testID}>
      {props.title ? <Text class="text-sm font-medium text-foreground">{props.title}</Text> : null}
      {(props.toolbar ?? true) ? (
        <View class="flex-row flex-wrap items-center" style={{ gap: 6 }}>
          <Each of={LOG_LEVELS as LogLevel[]}>
            {(l) => (
              <View
                role="checkbox"
                testID={props.testID ? `${props.testID}-level-${l()}` : undefined}
                accessibilityState={{ checked: shown().has(l()) }}
                accessibilityLabel={`${l()}: ${counts()[l()]} lines`}
                onPress={() => toggleLevel(l())}
                class="rounded-md border border-border px-2 py-1 hover:bg-accent"
                style={{ flexDirection: "row", alignItems: "center", gap: 5, opacity: shown().has(l()) ? 1 : 0.4 }}
              >
                <View style={{ width: 8, height: 8, borderRadius: 2, backgroundColor: colors()[l()] }} />
                <Text class="text-xs text-foreground">{l()}</Text>
                <Text class="text-xs text-muted-foreground" style={{ fontVariant: ["tabular-nums"] }}>
                  {counts()[l()].toLocaleString()}
                </Text>
              </View>
            )}
          </Each>
          <View style={{ flex: 1, minWidth: 140 }}>
            <Input
              value={text()}
              placeholder="Search logs"
              testID={props.testID ? `${props.testID}-search` : undefined}
              onChange={(e) => text.set(e.value)}
              class="rounded-md border border-input bg-background px-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-ring"
              style={{ height: 30 }}
            />
          </View>
        </View>
      ) : null}
      {(props.histogram ?? true) ? (
        <View style={{ height: props.histogramHeight ?? 96, position: "relative" }}>
          <Canvas
            style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, pointerEvents: "none" }}
            draw={(cx, size) => {
              const t = theme();
              const c = cx as unknown as Ctx2D;
              const font = fontOf(t);
              c.font = font;
              vol.measure = (s) => measureCached(c, font, s);
              vol.timeZone = tz();
              vol.fontSize = t.fontSize;
              vol.colors = colors();
              vol.range = range();
              vol.setSize(size.width, size.height);
              version();
              const [x0, x1] = viewRange();
              const f = filter();
              untracked(() => {
                vol.update(store(), f, x0, x1);
                renderLogVolume(c, vol, t, PATH);
                overlay.update((n) => n + 1);
              });
            }}
          />
          <Canvas
            style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}
            testID={props.testID ? `${props.testID}-histogram` : undefined}
            role="image"
            accessibilityLabel={histLabel()}
            accessibilityHint="Drag to show a time range, double-tap to show all"
            onStartShouldSetResponder={() => true}
            onMoveShouldSetResponder={() => true}
            onResponderTerminationRequest={() => false}
            onResponderGrant={onGrant}
            onResponderMove={onMove}
            onResponderRelease={onRelease}
            onResponderTerminate={onTerminate}
            onMouseMove={onMouseMove}
            onMouseLeave={onMouseLeave}
            draw={(cx) => {
              overlay();
              renderLogVolumeOverlay(cx as unknown as Ctx2D, vol, untracked(theme));
            }}
          />
        </View>
      ) : null}
      <View class="flex-row items-center" style={{ gap: 8 }}>
        <Text class="text-xs text-muted-foreground" testID={props.testID ? `${props.testID}-count` : undefined}>
          {`${rows().length.toLocaleString()} of ${total().toLocaleString()} lines`}
        </Text>
        {range() ? (
          <View
            role="button"
            onPress={() => setRange(null)}
            testID={props.testID ? `${props.testID}-clear-range` : undefined}
            class="rounded-md bg-secondary px-2 py-0.5 hover:bg-accent"
          >
            <Text class="text-xs text-secondary-foreground">
              {`${formatTime(range()![0], 1000, tz())} – ${formatTime(range()![1], 1000, tz())}  ×`}
            </Text>
          </View>
        ) : null}
      </View>
      <List
        each={rows()}
        style={{ flex: 1 }}
        testID={props.testID ? `${props.testID}-lines` : undefined}
        empty={<Text class="text-sm text-muted-foreground" style={{ padding: 12 }}>No lines match</Text>}
      >
        {(item, index) => {
          const open = () => selected() === item();
          const color = () => colors()[item().level] ?? theme().muted;
          return (
            <View
              role="button"
              testID={props.testID ? `${props.testID}-line-${index()}` : undefined}
              accessibilityLabel={`${item().level}, ${formatTimeFull(item().time, 1, tz())}, ${item().message}`}
              accessibilityState={{ expanded: open() }}
              onPress={() => select(item())}
              class="hover:bg-accent"
              style={{
                paddingVertical: 3,
                paddingHorizontal: 6,
                borderLeftWidth: 3,
                borderLeftColor: color(),
                backgroundColor: open() ? withAlpha(theme().selection, 0.08) : undefined,
              }}
            >
              <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
                <Text class="font-mono text-xs text-muted-foreground" style={{ fontVariant: ["tabular-nums"] }}>
                  {formatTime(item().time, 1, tz())}
                </Text>
                <Text class="font-mono text-xs" style={{ color: color(), width: 40 }}>
                  {item().level.toUpperCase()}
                </Text>
                {item().service ? (
                  <Text class="font-mono text-xs text-muted-foreground" style={{ width: 84, numberOfLines: 1 }}>
                    {item().service!}
                  </Text>
                ) : null}
                <Text class="font-mono text-xs text-foreground" style={{ flex: 1, numberOfLines: open() ? 0 : 1 }}>
                  {item().message}
                </Text>
              </View>
              {open() ? (
                <View style={{ paddingLeft: 12, paddingTop: 6, paddingBottom: 4, gap: 3 }}>
                  <Text class="font-mono text-xs text-muted-foreground">{formatTimeFull(item().time, 1, tz())}</Text>
                  <Each of={Object.entries(item().attributes ?? {})}>
                    {(kv) => (
                      <View style={{ flexDirection: "row", gap: 8 }}>
                        <Text class="font-mono text-xs text-muted-foreground" style={{ minWidth: 120 }}>
                          {kv()[0]}
                        </Text>
                        <Text class="font-mono text-xs text-foreground" style={{ flex: 1 }}>
                          {String(kv()[1])}
                        </Text>
                      </View>
                    )}
                  </Each>
                  {item().traceId ? (
                    <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                      <Text class="font-mono text-xs text-muted-foreground" style={{ minWidth: 120 }}>
                        trace_id
                      </Text>
                      <View
                        role="link"
                        testID={props.testID ? `${props.testID}-trace-link` : undefined}
                        onPress={() => props.onTraceClick?.(item().traceId!, item())}
                        class="rounded-md bg-secondary px-2 py-0.5 hover:bg-accent"
                      >
                        <Text class="font-mono text-xs text-primary">{`${item().traceId}  →`}</Text>
                      </View>
                    </View>
                  ) : null}
                </View>
              ) : null}
            </View>
          );
        }}
      </List>
    </View>
  );
}
