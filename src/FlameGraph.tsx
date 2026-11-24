/**
 * `<FlameGraph>`: a profile as a flame graph. Each frame is a function in a call stack, as wide as the
 * samples (or time, or bytes) spent in it and in what it calls. Press a frame to zoom to it (its callers
 * stay above, dimmed); press the root or a crumb to go back out, or double-click. Searching greys out
 * every frame that doesn't match and says how much of the profile the matches cover.
 */
import {
  Canvas,
  Path2D,
  Text,
  View,
  computed,
  effect,
  signal,
  untracked,
  type GestureResponderEvent,
  type KeyEvent,
  type MouseEvent,
  type ViewRef,
  type ViewStyle,
  type WheelEvent,
} from "nsh";
import { Input } from "nsh/base";
import { diffColor, FlameEngine, renderFlame, renderFlameOverlay } from "./flame";
import { ancestry, diffProfiles, matchedValue, profileFromFolded, profileFromTree, type ProfileNode, type ProfileTreeInput } from "./profile";
import { fontOf, type Ctx2D } from "./render";
import { formatValue, type Unit } from "./scale";
import { isDark, resolveTheme } from "./theme";
import type { ChartColors, ChartTheme } from "./types";

export interface FlameGraphProps {
  /** The profile: a tree from `profileFromFolded` / `profileFromStacks`, folded stacks as text, or a nested tree. */
  profile: ProfileNode | string | ProfileTreeInput;
  /**
   * A profile to compare with (before a deploy, say): frames are colored by how their share of the profile
   * changed, red where it grew and blue where it shrank, and the tooltip gives both.
   */
  baseline?: ProfileNode | string | ProfileTreeInput;
  /** What values are: "short" for samples (the default), "ns" or "ms" for time, "bytes" for allocations. */
  unit?: Unit;
  /** The root at the top (an icicle, the default) or at the bottom (a classic flame). */
  direction?: "down" | "up";
  /** Frame height in points. Default 18. */
  rowHeight?: number;
  /** Frames are colored by module (the default) or by function. */
  colorBy?: "module" | "name";
  /** The search box and the path to the zoomed frame. Default true. */
  toolbar?: boolean;
  /** Frames to pick out (controlled): those whose name contains it. */
  highlight?: string;
  colors?: ChartColors;
  fontFamily?: string;
  fontSize?: number;
  /** A frame was zoomed to (the root: zoomed out). */
  onSelect?: (node: ProfileNode) => void;
  style?: ViewStyle;
  class?: string;
  testID?: string;
  accessibilityLabel?: string;
}

const PATH = (d: string) => new Path2D(d);
const KEYS = ["up", "down", "left", "right", "enter", "space", "escape", "0", "backspace"] as const;
const DOUBLE_CLICK_MS = 350;

export function FlameGraph(props: FlameGraphProps) {
  const e = new FlameEngine();
  const plotFrame = signal(0);
  const overlayFrame = signal(0);
  const focus = signal<ProfileNode | null>(null);
  const cursor = signal<ProfileNode | null>(null);
  const search = signal(props.highlight ?? "");
  let gesture: { origin: number; originY: number; x: number; y: number; lastY: number; moved: boolean } | null = null;
  let lastTap = 0;
  // The plot canvas: a press gives it the keyboard, as Tab would.
  let plotRef: ViewRef | undefined;

  const theme = computed<ChartTheme>(() => resolveTheme(props.colors, props.fontFamily, props.fontSize));
  const toTree = (p: ProfileNode | string | ProfileTreeInput): ProfileNode => {
    if (typeof p === "string") return untracked(() => profileFromFolded(p));
    if ((p as ProfileNode).self !== undefined && (p as ProfileNode).depth !== undefined) return p as ProfileNode;
    return untracked(() => profileFromTree(p as ProfileTreeInput));
  };
  const root = computed<ProfileNode>(() => {
    const p = toTree(props.profile);
    const b = props.baseline;
    return b ? untracked(() => diffProfiles(toTree(b), p)) : p;
  });
  const diffing = () => root().baseline !== undefined;

  effect(() => {
    const h = props.highlight;
    if (h !== undefined) untracked(() => search.set(h));
  });
  effect(() => {
    const r = root();
    untracked(() => {
      e.setRoot(r);
      focus.set(r);
      cursor.set(null);
      plotFrame.update((n) => n + 1);
    });
  });
  effect(() => {
    e.direction = props.direction ?? "down";
    e.rowHeight = props.rowHeight ?? 18;
    e.unit = props.unit ?? "short";
    e.colorBy = props.colorBy ?? "module";
    e.highlight = search();
    untracked(() => plotFrame.update((n) => n + 1));
  });

  const zoomTo = (n: ProfileNode | null) => {
    e.zoomTo(n);
    focus.set(e.focus);
    cursor.set(e.cursor);
    plotFrame.update((v) => v + 1);
    if (e.focus) props.onSelect?.(e.focus);
  };

  const onGrant = (ev: GestureResponderEvent) => {
    plotRef?.focus();
    gesture = { origin: ev.pageX - ev.locationX, originY: ev.pageY - ev.locationY, x: ev.locationX, y: ev.locationY, lastY: ev.locationY, moved: false };
    return true;
  };
  const onMove = (ev: GestureResponderEvent) => {
    const g = gesture;
    if (!g) return;
    const y = ev.pageY - g.originY;
    if (!g.moved && Math.abs(y - g.y) + Math.abs(ev.pageX - g.origin - g.x) > 5) g.moved = true;
    if (g.moved) {
      e.scrollBy(g.lastY - y);
      plotFrame.update((n) => n + 1);
    }
    g.lastY = y;
  };
  const onRelease = () => {
    const g = gesture;
    gesture = null;
    if (!g || g.moved) return;
    const now = Date.now();
    if (now - lastTap < DOUBLE_CLICK_MS) {
      lastTap = 0;
      zoomTo(null);
      return;
    }
    lastTap = now;
    const fr = e.frameAt(g.x, g.y);
    if (!fr) return;
    e.cursor = fr.node;
    zoomTo(fr.node === e.focus && fr.node.parent ? fr.node.parent : fr.node);
  };
  const onWheel = (ev: WheelEvent) => {
    e.scrollBy(ev.deltaMode === "lines" ? ev.delta.y * 40 : ev.delta.y);
    e.hover = e.frameAt(ev.position.x, ev.position.y);
    plotFrame.update((n) => n + 1);
  };
  const onMouseMove = (ev: MouseEvent) => {
    if (gesture) return;
    e.pointer = { x: ev.position.x, y: ev.position.y };
    e.hover = e.frameAt(ev.position.x, ev.position.y);
    overlayFrame.update((n) => n + 1);
  };
  const onMouseLeave = () => {
    e.hover = null;
    overlayFrame.update((n) => n + 1);
  };
  const onKeyDown = (ev: KeyEvent) => {
    // Arrows walk the frames (toward the root is up on screen in an icicle, down in a flame); Enter zooms.
    const down = e.direction === "down";
    const step: Record<string, "parent" | "child" | "prev" | "next"> = {
      ArrowUp: down ? "parent" : "child",
      ArrowDown: down ? "child" : "parent",
      ArrowLeft: "prev",
      ArrowRight: "next",
    };
    const dir = step[ev.key];
    if (dir) {
      if (e.moveCursor(dir)) {
        focus.set(e.focus);
        cursor.set(e.cursor);
        if (e.cursor) e.revealDepth(e.cursor.depth);
        plotFrame.update((n) => n + 1);
      }
      return;
    }
    if ((ev.key === "Enter" || ev.key === " ") && e.cursor) zoomTo(e.cursor);
    else if (ev.key === "Escape" || ev.key === "0") zoomTo(null);
    else if (ev.key === "Backspace") zoomTo(e.focus?.parent ?? null);
  };

  const matched = computed(() => {
    const s = search();
    return s.trim() ? matchedValue(root(), s) : 0;
  });

  const label = () => {
    const r = root();
    const f = focus() ?? r;
    const base = props.accessibilityLabel ?? "Flame graph";
    const unit = props.unit ?? "short";
    const pct = (v: number) => `${((v / (r.value || 1)) * 100).toFixed(1)}% of the total`;
    const head = f === r ? `${base}: ${formatValue(r.value, unit)} in total` : `${base}, zoomed to ${f.name}: ${formatValue(f.value, unit)}, ${pct(f.value)}`;
    const c = cursor();
    return c ? `${head}. On ${c.name}: ${formatValue(c.value, unit)}, ${pct(c.value)}, self ${formatValue(c.self, unit)}` : head;
  };

  return (
    <View style={{ flexDirection: "column", gap: 6, ...props.style }} class={props.class} testID={props.testID}>
      {(props.toolbar ?? true) ? (
        <View class="flex-row flex-wrap items-center" style={{ gap: 8 }}>
          <View class="flex-row flex-wrap items-center" style={{ gap: 2, flex: 1, minWidth: 160 }}>
            <Each of={ancestry(focus() ?? root())}>
              {(n, i) => (
                <View class="flex-row items-center" style={{ gap: 2 }}>
                  {i() > 0 ? <Text class="text-xs text-muted-foreground">›</Text> : null}
                  <View
                    role="button"
                    testID={props.testID ? `${props.testID}-crumb-${i()}` : undefined}
                    onPress={() => zoomTo(n())}
                    class="rounded px-1 hover:bg-accent"
                  >
                    <Text class={`text-xs ${n() === (focus() ?? root()) ? "text-foreground font-medium" : "text-muted-foreground"}`} style={{ numberOfLines: 1 }}>
                      {n().name}
                    </Text>
                  </View>
                </View>
              )}
            </Each>
          </View>
          {diffing() ? (
            <View class="flex-row items-center" style={{ gap: 6 }} testID={props.testID ? `${props.testID}-diff-legend` : undefined}>
              <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: diffColor(-1, isDark(theme())) }} />
              <Text class="text-xs text-muted-foreground">less</Text>
              <View style={{ width: 10, height: 10, borderRadius: 2, backgroundColor: diffColor(1, isDark(theme())) }} />
              <Text class="text-xs text-muted-foreground">more than baseline</Text>
            </View>
          ) : null}
          {search().trim() ? (
            <Text class="text-xs text-muted-foreground" testID={props.testID ? `${props.testID}-matched` : undefined}>
              {`${((matched() / (root().value || 1)) * 100).toFixed(1)}% matched`}
            </Text>
          ) : null}
          <View style={{ width: 200 }}>
            <Input
              value={search()}
              placeholder="Search functions"
              testID={props.testID ? `${props.testID}-search` : undefined}
              onChange={(ev) => search.set(ev.value)}
              class="rounded-md border border-input bg-background px-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-ring"
              style={{ height: 30 }}
            />
          </View>
        </View>
      ) : null}
      <View style={{ flex: 1, position: "relative", minHeight: 60 }}>
        <Canvas
          style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, pointerEvents: "none" }}
          draw={(cx, size) => {
            plotFrame();
            const t = theme();
            untracked(() => {
              const c = cx as unknown as Ctx2D;
              c.font = fontOf(t);
              e.dark = isDark(t);
              e.setSize(size.width, size.height);
              e.layout();
              renderFlame(c, e, t, PATH);
              overlayFrame.update((n) => n + 1);
            });
          }}
        />
        <Canvas
          style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}
          testID={props.testID ? `${props.testID}-plot` : undefined}
          role="image"
          accessibilityLabel={label()}
          accessibilityHint="Arrow keys move between frames, Enter zooms to one, Escape zooms out, Backspace goes up a level"
          focusable
          ref={(r) => (plotRef = r)}
          captureKeys={KEYS}
          onKeyDown={onKeyDown}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderTerminationRequest={() => false}
          onResponderGrant={onGrant}
          onResponderMove={onMove}
          onResponderRelease={onRelease}
          onResponderTerminate={() => (gesture = null)}
          onWheel={onWheel}
          onMouseMove={onMouseMove}
          onMouseLeave={onMouseLeave}
          draw={(cx) => {
            overlayFrame();
            const t = untracked(theme);
            const c = cx as unknown as Ctx2D;
            c.font = fontOf(t);
            renderFlameOverlay(c, e, t);
          }}
        />
      </View>
    </View>
  );
}
