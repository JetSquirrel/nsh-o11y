/**
 * A profile as a call tree: each node a function in a stack, its value the samples (or nanoseconds, or
 * bytes) spent in it and under it, its self value the part spent in it alone. Built from folded stacks
 * (`main;handle;parse 42`, as Brendan Gregg's flamegraph.pl and most profilers export), from stacks of
 * frames, or from a tree. Plain TypeScript, no NSH imports.
 */

export interface ProfileNode {
  name: string;
  /** Spent in it and in what it calls. */
  value: number;
  /** Spent in it alone. */
  self: number;
  children: ProfileNode[];
  parent: ProfileNode | null;
  depth: number;
}

/** A tree as a profiler might give it: `value` may be left out (the sum of the children's). */
export interface ProfileTreeInput {
  name: string;
  value?: number;
  children?: ProfileTreeInput[];
}

function node(name: string, parent: ProfileNode | null): ProfileNode {
  return { name, value: 0, self: 0, children: [], parent, depth: parent ? parent.depth + 1 : 0 };
}

/** Builds the tree from stacks, root frame first. Identical frames under one parent are merged. */
export function profileFromStacks(stacks: Iterable<{ frames: readonly string[]; value?: number }>, rootName = "all"): ProfileNode {
  const root = node(rootName, null);
  const index = new Map<ProfileNode, Map<string, ProfileNode>>();
  for (const { frames, value = 1 } of stacks) {
    if (!(value > 0)) continue;
    root.value += value;
    let at = root;
    for (const f of frames) {
      let m = index.get(at);
      if (!m) index.set(at, (m = new Map()));
      let c = m.get(f);
      if (!c) {
        c = node(f, at);
        m.set(f, c);
        at.children.push(c);
      }
      c.value += value;
      at = c;
    }
    at.self += value;
  }
  sortProfile(root, "value");
  return root;
}

/** Parses folded stacks: one `frame;frame;frame value` per line. */
export function profileFromFolded(text: string, rootName = "all"): ProfileNode {
  const stacks: { frames: string[]; value: number }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const sp = line.lastIndexOf(" ");
    const value = sp > 0 ? Number(line.slice(sp + 1)) : NaN;
    if (!(value > 0)) continue;
    stacks.push({ frames: line.slice(0, sp).split(";").filter((f) => f.length > 0), value });
  }
  return profileFromStacks(stacks, rootName);
}

/** Builds the tree from nested `{ name, value?, children? }`. */
export function profileFromTree(tree: ProfileTreeInput): ProfileNode {
  const build = (t: ProfileTreeInput, parent: ProfileNode | null): ProfileNode => {
    const n = node(t.name, parent);
    let sum = 0;
    for (const c of t.children ?? []) {
      const cn = build(c, n);
      n.children.push(cn);
      sum += cn.value;
    }
    n.value = Math.max(t.value ?? sum, sum);
    n.self = n.value - sum;
    return n;
  };
  const root = build(tree, null);
  sortProfile(root, "value");
  return root;
}

/** Orders every node's children: biggest first, or by name (as flamegraph.pl does). */
export function sortProfile(root: ProfileNode, by: "value" | "name") {
  const cmp = by === "value" ? (a: ProfileNode, b: ProfileNode) => b.value - a.value || (a.name < b.name ? -1 : 1) : (a: ProfileNode, b: ProfileNode) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    n.children.sort(cmp);
    for (const c of n.children) stack.push(c);
  }
}

/** The path from the root to the node, root first. */
export function ancestry(n: ProfileNode): ProfileNode[] {
  const out: ProfileNode[] = [];
  for (let p: ProfileNode | null = n; p; p = p.parent) out.push(p);
  return out.reverse();
}

export interface FunctionTotal {
  name: string;
  /** Spent in it alone, wherever it is called from. */
  self: number;
  /** Spent in it and under it, each sample counted once even when it recurses. */
  total: number;
}

/** Every function's self and total value, biggest self first: a profiler's "top" table. */
export function topFunctions(root: ProfileNode, limit = Infinity): FunctionTotal[] {
  const map = new Map<string, FunctionTotal>();
  const onStack = new Map<string, number>();
  const visit = (n: ProfileNode) => {
    if (n.parent) {
      let f = map.get(n.name);
      if (!f) map.set(n.name, (f = { name: n.name, self: 0, total: 0 }));
      f.self += n.self;
      // Recursion: only the outermost call counts toward the total.
      if (!onStack.get(n.name)) f.total += n.value;
      onStack.set(n.name, (onStack.get(n.name) ?? 0) + 1);
    }
    for (const c of n.children) visit(c);
    if (n.parent) onStack.set(n.name, onStack.get(n.name)! - 1);
  };
  visit(root);
  return [...map.values()].sort((a, b) => b.self - a.self || b.total - a.total).slice(0, limit);
}

/** The value of frames whose name contains `text` (case-insensitive), nested matches counted once. */
export function matchedValue(root: ProfileNode, text: string): number {
  const needle = text.trim().toLowerCase();
  if (!needle) return 0;
  let sum = 0;
  const stack = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.parent && n.name.toLowerCase().indexOf(needle) >= 0) sum += n.value;
    else for (const c of n.children) stack.push(c);
  }
  return sum;
}
