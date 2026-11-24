/**
 * `<SandwichView>`: one function of a profile, with what called it above and what it called below. The
 * callers are a flame growing up into the function (its root, at the bottom, is the function); the callees
 * an icicle hanging from it, its calls from every place merged. A function that shows up as many narrow
 * frames in the full flame graph (an allocator, a lock, JSON) reads here as two whole trees.
 */
import { Text, View, computed, untracked, type ViewStyle } from "nsh";
import { FlameGraph } from "./FlameGraph";
import { profileFromFolded, profileFromTree, sandwichProfile, type ProfileNode, type ProfileTreeInput } from "./profile";
import { formatValue, type Unit } from "./scale";
import type { ChartColors } from "./types";

export interface SandwichViewProps {
  /** The whole profile, as `FlameGraph` takes it. */
  profile: ProfileNode | string | ProfileTreeInput;
  /** The function in the middle, by its frame name. */
  fn: string;
  unit?: Unit;
  rowHeight?: number;
  colorBy?: "module" | "name";
  colors?: ChartColors;
  fontFamily?: string;
  fontSize?: number;
  /** A frame in either half was zoomed to. */
  onSelect?: (node: ProfileNode) => void;
  style?: ViewStyle;
  class?: string;
  testID?: string;
}

export function SandwichView(props: SandwichViewProps) {
  const root = computed<ProfileNode>(() => {
    const p = props.profile;
    if (typeof p === "string") return untracked(() => profileFromFolded(p));
    if ((p as ProfileNode).self !== undefined && (p as ProfileNode).depth !== undefined) return p as ProfileNode;
    return untracked(() => profileFromTree(p as ProfileTreeInput));
  });
  const parts = computed(() => sandwichProfile(root(), props.fn));
  const share = () => {
    const s = parts();
    return s ? `${formatValue(s.callees.value, props.unit ?? "short")} · ${((s.callees.value / (root().value || 1)) * 100).toFixed(1)}% of the total` : "";
  };
  const half = (which: "callers" | "callees") => {
    const s = parts();
    if (!s) return null;
    return (
      <FlameGraph
        testID={props.testID ? `${props.testID}-${which}` : undefined}
        profile={s[which]}
        direction={which === "callers" ? "up" : "down"}
        toolbar={false}
        unit={props.unit}
        rowHeight={props.rowHeight}
        colorBy={props.colorBy}
        colors={props.colors}
        fontFamily={props.fontFamily}
        fontSize={props.fontSize}
        onSelect={props.onSelect}
        accessibilityLabel={which === "callers" ? `Callers of ${props.fn}` : `Called by ${props.fn}`}
        style={{ flex: 1 }}
      />
    );
  };
  return (
    <View style={{ flexDirection: "column", gap: 4, ...props.style }} class={props.class} testID={props.testID}>
      {parts() ? (
        <View style={{ flex: 1, gap: 4 }}>
          <Text class="text-xs text-muted-foreground">Callers ↑</Text>
          {half("callers")}
          <View class="flex-row items-center" style={{ gap: 8 }}>
            <Text class="font-mono text-xs font-medium text-foreground" style={{ flex: 1, numberOfLines: 1, textOverflow: "ellipsis-start" }}>
              {props.fn}
            </Text>
            <Text class="text-xs text-muted-foreground" testID={props.testID ? `${props.testID}-total` : undefined}>
              {share()}
            </Text>
          </View>
          {half("callees")}
          <Text class="text-xs text-muted-foreground">Callees ↓</Text>
        </View>
      ) : (
        <Text class="text-sm text-muted-foreground">{`No frame named ${props.fn}`}</Text>
      )}
    </View>
  );
}
