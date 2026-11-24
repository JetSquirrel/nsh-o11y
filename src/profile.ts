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
  /** In a diff (`diffProfiles`): the same stack's value in the baseline profile. */
  baseline?: number;
  /** In a diff: the baseline's self value. */
  baselineSelf?: number;
}

/**
 * The change from `before` to `after` as one tree: `after`'s shape and values, each node with its value in
 * `before` as `baseline` (0 when the stack is new). Stacks only in `before` are kept with a value of 0, so
 * they take no width but are still found by search and in the table. The root's two values are the
 * profiles' totals: compare shares (`value / root.value` against `baseline / root.baseline`) when the two
 * were sampled for different lengths of time.
 */
export function diffProfiles(before: ProfileNode, after: ProfileNode): ProfileNode {
  const copy = (a: ProfileNode | undefined, b: ProfileNode | undefined, parent: ProfileNode | null): ProfileNode => {
    const n: ProfileNode = {
      name: (a ?? b)!.name,
      value: a?.value ?? 0,
      self: a?.self ?? 0,
      children: [],
      parent,
      depth: parent ? parent.depth + 1 : 0,
      baseline: b?.value ?? 0,
      baselineSelf: b?.self ?? 0,
    };
    const bKids = new Map<string, ProfileNode>();
    for (const c of b?.children ?? []) bKids.set(c.name, c);
    for (const c of a?.children ?? []) {
      n.children.push(copy(c, bKids.get(c.name), n));
      bKids.delete(c.name);
    }
    for (const c of bKids.values()) n.children.push(copy(undefined, c, n));
    return n;
  };
  const root = copy(after, before, null);
  sortProfile(root, "value");
  return root;
}

/**
 * How much a node's share of the profile changed, from -1 (it was all of the baseline and is gone) to 1 (it
 * is new): (share after − share before) / the larger share. 0 when it is not a diff or did not change.
 */
export function diffRatio(n: ProfileNode, root: ProfileNode): number {
  if (n.baseline === undefined || root.baseline === undefined) return 0;
  const a = root.value > 0 ? n.value / root.value : 0;
  const b = root.baseline > 0 ? n.baseline / root.baseline : 0;
  const m = Math.max(a, b);
  return m > 0 ? (a - b) / m : 0;
}

/**
 * A function's sandwich: `callers`, an inverted tree rooted at the function whose children are the
 * functions that called it, then theirs, out to the root's children; and `callees`, the function's own
 * subtrees from every place it was called, merged. Both roots hold the function's total. Recursion counts
 * once: only the outermost call of each stack is taken. Null when no frame has that name.
 */
export function sandwichProfile(root: ProfileNode, name: string): { callers: ProfileNode; callees: ProfileNode } | null {
  const outer: ProfileNode[] = [];
  const stack: ProfileNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.parent && n.name === name) outer.push(n);
    else for (const c of n.children) stack.push(c);
  }
  if (!outer.length) return null;
  const callers = node(name, null);
  const callees = node(name, null);
  const kids = new Map<ProfileNode, Map<string, ProfileNode>>();
  const child = (p: ProfileNode, nm: string) => {
    let m = kids.get(p);
    if (!m) kids.set(p, (m = new Map()));
    let c = m.get(nm);
    if (!c) {
      c = node(nm, p);
      m.set(nm, c);
      p.children.push(c);
    }
    return c;
  };
  const merge = (from: ProfileNode, into: ProfileNode) => {
    into.value += from.value;
    into.self += from.self;
    for (const c of from.children) merge(c, child(into, c.name));
  };
  for (const n of outer) {
    // Callers: up from the call to the profile's root (left out: it is "all", not a function).
    callers.value += n.value;
    callers.self += n.value;
    let at = callers;
    for (let p = n.parent; p && p.parent; p = p.parent) {
      at.self -= n.value;
      at = child(at, p.name);
      at.value += n.value;
      at.self += n.value;
    }
    merge(n, callees);
  }
  sortProfile(callers, "value");
  sortProfile(callees, "value");
  return { callers, callees };
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
/**
 * Finds or makes a node's child by name. Most nodes have a few children, found by scanning them (no Map
 * to allocate); past `SCAN` children a Map is made for that node alone.
 */
const SCAN = 8;
class TreeBuilder {
  private maps = new Map<ProfileNode, Map<string, ProfileNode>>();

  child(at: ProfileNode, name: string): ProfileNode {
    const kids = at.children;
    if (kids.length <= SCAN) {
      for (let i = 0; i < kids.length; i++) if (kids[i].name === name) return kids[i];
      const c = node(name, at);
      kids.push(c);
      if (kids.length > SCAN) {
        const m = new Map<string, ProfileNode>();
        for (const k of kids) m.set(k.name, k);
        this.maps.set(at, m);
      }
      return c;
    }
    const m = this.maps.get(at)!;
    let c = m.get(name);
    if (!c) {
      c = node(name, at);
      kids.push(c);
      m.set(name, c);
    }
    return c;
  }
}

export function profileFromStacks(stacks: Iterable<{ frames: readonly string[]; value?: number }>, rootName = "all"): ProfileNode {
  const root = node(rootName, null);
  const tree = new TreeBuilder();
  for (const { frames, value = 1 } of stacks) {
    if (!(value > 0)) continue;
    root.value += value;
    let at = root;
    for (const f of frames) {
      at = tree.child(at, f);
      at.value += value;
    }
    at.self += value;
  }
  sortProfile(root, "value");
  return root;
}

/**
 * Parses folded stacks: one `frame;frame;frame value` per line. Each line is walked in place (no arrays of
 * frames), straight into the tree.
 */
export function profileFromFolded(text: string, rootName = "all"): ProfileNode {
  const root = node(rootName, null);
  const tree = new TreeBuilder();
  let pos = 0;
  const n = text.length;
  while (pos < n) {
    let end = text.indexOf("\n", pos);
    if (end < 0) end = n;
    let a = pos;
    let b = end;
    pos = end + 1;
    while (a < b && text.charCodeAt(a) <= 32) a++;
    while (b > a && text.charCodeAt(b - 1) <= 32) b--;
    if (a === b || text.charCodeAt(a) === 35 /* # */) continue;
    const sp = text.lastIndexOf(" ", b - 1);
    if (sp <= a) continue;
    const value = Number(text.slice(sp + 1, b));
    if (!(value > 0)) continue;
    root.value += value;
    let at = root;
    let f = a;
    while (f < sp) {
      let semi = text.indexOf(";", f);
      if (semi < 0 || semi > sp) semi = sp;
      if (semi > f) {
        at = tree.child(at, text.slice(f, semi));
        at.value += value;
      }
      f = semi + 1;
    }
    at.self += value;
  }
  sortProfile(root, "value");
  return root;
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
