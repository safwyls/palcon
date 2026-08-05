import { SPECIES_IDS, altChildOfPair, childOfPair, isSpecialPair, speciesIndexOf } from "./breeding";
import { passiveTier } from "./paldex";

/**
 * Breeding route planner: from the pals actually in the save, find the best
 * ways to breed a target species — ranked on the two things a breeder is
 * actually chasing, talents and passive skills.
 *
 * Model: a route is a binary tree whose leaves are owned pals and whose inner
 * nodes are breeding steps. Parents aren't consumed by breeding, so anything
 * hatched joins the pool and can parent any number of later pairs; the cost
 * that's minimized is therefore *generations* (an intermediate's depth), and
 * the egg count quoted to the user is the number of distinct steps after
 * merging identical subtrees.
 *
 * A node's "ceiling" is its best case. For talents, each stat inherits from
 * either parent (or rerolls), so with perfect luck a child gets the per-stat
 * max of its parents and a route's talent ceiling is the per-stat max over its
 * owned leaves. Passives work the same way one level at a time — the child
 * draws from its parents' pooled passives — so the set a route can *reach* is
 * the union of its leaves' passives. A pal only holds four at once, which is
 * why routes are scored on their best four (see TIER_VALUE) rather than on
 * pool size, and why the UI says "can reach" rather than promising them all.
 *
 * Per species and generation the solver keeps a handful of champion
 * derivations — best talent sum, best of each single stat, best passives, best
 * blend, fewest Reversers — ties going to smaller trees. That's a deliberate
 * heuristic rather than a full Pareto frontier: every route it returns is
 * executable and its ceilings honest, but a marginally better route can in
 * principle be missed. Rounds grow the champions generation by generation —
 * earlier generations are final before the next is formed — by pairing species
 * through the forward table (~46k pairs), bounded by the target's minimum
 * generation (from a fast generations-only relaxation) plus EXTRA_GENERATIONS,
 * and skipping species that can't sit inside a within-bound derivation of the
 * target.
 *
 * Every derivation of the target is additionally offered to a keeper that
 * holds the best few per tree size, per ranking the UI can ask for — sizes are
 * kept apart so cheap routes aren't crowded out by richer expensive ones.
 * Those survivors are reconstructed, deduped and bucketed by egg count, and
 * the UI ranks within a bucket via {@link rankRoutes}.
 *
 * Gender is deliberately not modeled (except that a pal can't be paired with
 * itself); the UI carries that caveat instead.
 */

/** What the solver needs to know about an owned pal. `SavePal` satisfies it. */
export interface PathPal {
  /** Stable instance id — tells two pals of the same species apart. */
  key: string;
  characterId: string;
  ivHp: number;
  ivAttack: number;
  ivDefense: number;
  /** "male" | "female" | "" — pairing two same-sex owned pals needs a Pal
   * Reverser, which the planner avoids when it costs no ceiling. */
  gender?: string;
  /** Passive skill codes carried, which the route's descendants can inherit. */
  passives?: readonly string[];
}

/** Best-case talents as [HP, Attack, Defense]. */
export type Ceiling = readonly [number, number, number];

export type StepParent<P extends PathPal> =
  | { kind: "owned"; pal: P }
  | { kind: "egg"; n: number; speciesId: string };

export interface BreedStep<P extends PathPal> {
  /** 1-based position in breed order; later steps may reuse this egg's pal. */
  n: number;
  childId: string;
  special: boolean;
  ceiling: Ceiling;
  a: StepParent<P>;
  b: StepParent<P>;
}

export interface RouteOption<P extends PathPal> {
  /** Structural identity — stable across re-plans, unique per distinct route. */
  id: string;
  /** Eggs to hatch, after merging reused intermediates. */
  eggs: number;
  ceiling: Ceiling;
  /** In breed order; the last step's child is the target. Empty when eggs=0. */
  steps: BreedStep<P>[];
  /** The already-owned target instance, for the 0-egg option. */
  ownedTarget?: P;
  /** Steps that pair two same-sex owned pals — each needs a Pal Reverser. */
  reversers: number;
  /** Passives this route can reach, best tier first. A pal holds four. */
  passives: string[];
  /** Weighted worth of the best four of those — 0–300, see TIER_VALUE. */
  passiveScore: number;
}

/** Routes that cost the same number of eggs, cheapest bucket first. */
export interface RouteBucket<P extends PathPal> {
  eggs: number;
  routes: RouteOption<P>[];
}

export type PlanResult<P extends PathPal> =
  | {
      status: "ok";
      /** The best copy already in the box, when there is one. */
      owned?: RouteOption<P>;
      /** The three cheapest reachable egg counts, cheapest first. */
      buckets: RouteBucket<P>[];
    }
  | { status: "notBreedable" }
  | { status: "unreachable" };

/** Generations past the minimum to explore for a better ceiling. */
const EXTRA_GENERATIONS = 2;
/** Egg counts the board compares — the cheapest this many, e.g. 1, 2 and 3. */
const BUCKETS = 3;
/** Kept per tree size per ranking, before reconstruction picks the winners. */
const KEEP_PER_SIZE = 40;
/** Tree sizes tracked by the keeper; a 4-egg route unfolds to at most 15. */
const MAX_KEPT_SIZE = 16;

/**
 * What a reachable passive is worth to a route, indexed by the game's tier
 * ladder (1–3 up-arrows, 4 Rainbow, 5 World Tree). Scaled so a route's best
 * four top out at 300 — the same span as a 100/100/100 talent ceiling, so
 * "Balanced" weighs the two axes evenly. Tier 0 and below are worth nothing:
 * junk passives and outright penalties aren't what anyone breeds toward.
 */
const TIER_VALUE = [0, 20, 35, 50, 65, 75];
/** Tracked passive codes, two words shy of the whole 115-entry tier catalog. */
const PASSIVE_BITS = 128;

export type RankMode = "balanced" | "talents" | "passives";

interface Entry<P extends PathPal> {
  /** Generation: 0 for an owned pal, else max(parents) + 1. */
  gen: number;
  iv: Ceiling;
  /** Passives reachable below this node, as a 128-bit mask over `codes`. */
  m0: number;
  m1: number;
  m2: number;
  m3: number;
  /** Worth of the best four passives in that mask — cached, ranked on often. */
  pv: number;
  /** Tree size in breeding steps before subtree merging — the egg-count bias. */
  size: number;
  /** Same-sex owned pairings in this derivation, pre-merging. */
  reversers: number;
  /** Cached {@link groupOf} — the champion scan reads it on every comparison. */
  grp: string;
  leaf?: P;
  pair?: { ai: number; a: Entry<P>; bi: number; b: Entry<P>; ci: number };
}

const ivSum = (iv: Ceiling) => iv[0] + iv[1] + iv[2];

/**
 * Champion criteria: talent sum, each single stat, fewest Reversers (dominant
 * over sum, so a Reverser-free derivation always survives pruning), best
 * passives, and the blend of talents and passives. Together they sample the
 * corners of the frontier the UI can rank by.
 */
const N_CRITERIA = 7;
function score(e: Entry<PathPal>, k: number): number {
  if (k === 0) return ivSum(e.iv);
  if (k <= 3) return e.iv[k - 1];
  if (k === 4) return -e.reversers * 1_000_000 + ivSum(e.iv);
  if (k === 5) return e.pv * 1_000 + ivSum(e.iv);
  return ivSum(e.iv) + e.pv;
}
function beats(a: Entry<PathPal>, b: Entry<PathPal>, k: number): boolean {
  const d = score(a, k) - score(b, k);
  if (d !== 0) return d > 0;
  // Ties go to routes that skip the Pal Reverser, then to smaller trees.
  if (a.reversers !== b.reversers) return a.reversers < b.reversers;
  return a.size < b.size;
}

/** Champions are kept per group so an opposite-sex copy of a species isn't
 * pruned away by a same-sex sibling with marginally better talents. */
const BRED_GROUP = "bred";

/** One species at one generation. `members` is the flat champion list the
 * pairing rounds walk; the per-group `best` array is what makes rejection
 * cheap — a candidate that beats no criterion's current holder is out after
 * N_CRITERIA comparisons instead of a full scan of the bucket. */
interface GenBucket<P extends PathPal> {
  members: Entry<P>[];
  dirty: boolean;
  groups: Map<string, { list: Entry<P>[]; best: Entry<P>[] }>;
}

function membersOf<P extends PathPal>(bucket: GenBucket<P> | undefined): Entry<P>[] | undefined {
  if (!bucket) return undefined;
  if (bucket.dirty) {
    bucket.members = [];
    for (const group of bucket.groups.values()) bucket.members.push(...group.list);
    bucket.dirty = false;
  }
  return bucket.members;
}

/** How the keeper — and then the board — orders routes under each ranking.
 * Talents and passives lead with their own axis and settle ties on the other,
 * so neither mode ever prefers a strictly worse route. */
function rankScore(iv: number, pv: number, reversers: number, mode: RankMode): number {
  if (mode === "talents") return iv * 1_000 + pv;
  if (mode === "passives") return pv * 1_000 + iv;
  // A Reverser is a real errand: worth about a third of a talent point per stat.
  return iv + pv - reversers * 10;
}
const RANK_MODES: RankMode[] = ["balanced", "talents", "passives"];

export function planRoutes<P extends PathPal>(owned: P[], targetId: string): PlanResult<P> {
  const n = SPECIES_IDS.length;
  const target = speciesIndexOf(targetId);
  if (target === undefined) return { status: "notBreedable" };

  // Passive codes present in this pool, best tier first, interned as bits. The
  // sort is what makes scoring cheap: the lowest set bits of a mask are its
  // best passives, so the best four fall out of a single ascending bit scan.
  const codes = [...new Set(owned.flatMap((p) => p.passives ?? []))]
    .sort((a, b) => passiveTier(b) - passiveTier(a) || a.localeCompare(b))
    .slice(0, PASSIVE_BITS);
  const bitOf = new Map(codes.map((code, i) => [code, i]));
  const bitValue = codes.map((code) => TIER_VALUE[Math.max(0, Math.min(5, passiveTier(code)))]);

  /** Worth of the best four passives in a mask. Bits ascend by tier, so the
   * first zero-valued bit means nothing better is left to find. */
  const passiveValue = (m0: number, m1: number, m2: number, m3: number): number => {
    let total = 0;
    let taken = 0;
    for (let w = 0; w < 4; w++) {
      let bits = w === 0 ? m0 : w === 1 ? m1 : w === 2 ? m2 : m3;
      while (bits !== 0) {
        const low = bits & -bits;
        const value = bitValue[w * 32 + (31 - Math.clz32(low))];
        if (!value) return total;
        total += value;
        if (++taken === 4) return total;
        bits ^= low;
      }
    }
    return total;
  };

  const maskCodes = (e: Entry<P>): string[] => {
    const out: string[] = [];
    for (let w = 0; w < 4; w++) {
      let bits = w === 0 ? e.m0 : w === 1 ? e.m1 : w === 2 ? e.m2 : e.m3;
      while (bits !== 0) {
        const low = bits & -bits;
        out.push(codes[w * 32 + (31 - Math.clz32(low))]);
        bits ^= low;
      }
    }
    return out;
  };

  // byGen[species][generation] = champion derivations, one per criterion.
  const byGen: GenBucket<P>[][] = Array.from({ length: n }, () => []);

  // Hot path: called once per candidate pairing — millions of times on a big
  // save — and rejecting almost all of them. Rejection is the fast route out.
  const insert = (species: number, cand: Entry<P>) => {
    const gens = byGen[species];
    const bucket = (gens[cand.gen] ??= { members: [], dirty: false, groups: new Map() });
    let group = bucket.groups.get(cand.grp);
    if (!group) {
      group = { list: [], best: [] };
      bucket.groups.set(cand.grp, group);
    }
    // Gate on every criterion having a holder, not on the list being long:
    // one entry routinely wins several crowns (the best talent sum usually
    // also takes k=4/5/6), so after the first prune the list sits at 1–4 and
    // a length test would never fire — sending nearly every candidate down
    // the slow path this exists to avoid, and leaving non-champions in
    // `list` for `membersOf` to walk as though they were champions.
    if (group.best.length === N_CRITERIA) {
      let champion = false;
      for (let k = 0; k < N_CRITERIA && !champion; k++) champion = beats(cand, group.best[k], k);
      if (!champion) return;
    }
    group.list.push(cand);
    // A new champion arrived, so re-crown every criterion and drop whatever no
    // longer holds one. Species settle quickly, making this the rare path.
    for (let k = 0; k < N_CRITERIA; k++) {
      let best = group.list[0];
      for (let m = 1; m < group.list.length; m++) if (beats(group.list[m], best, k)) best = group.list[m];
      group.best[k] = best;
    }
    // Prune after every re-crown, not only past a length threshold: the
    // survivors are exactly the crown holders.
    const keep = new Set(group.best);
    if (group.list.length > keep.size) group.list = group.list.filter((e) => keep.has(e));
    bucket.dirty = true;
  };

  // Every derivation of the target, kept per tree size so a 1-egg route is
  // never crowded out by a richer 3-egg one, and per ranking so switching the
  // board's sort never needs a re-plan.
  const kept: Entry<P>[][][] = RANK_MODES.map(() => []);
  const offer = (cand: Entry<P>) => {
    if (cand.size < 1) return;
    // Sizes past the tracked range share the last slot rather than being
    // dropped: a deep target's cheapest route can still be a big tree, and
    // losing it would leave the board with nothing to show.
    const slot = Math.min(cand.size, MAX_KEPT_SIZE);
    for (let m = 0; m < RANK_MODES.length; m++) {
      const list = (kept[m][slot] ??= []);
      list.push(cand);
      if (list.length >= KEEP_PER_SIZE * 3) {
        const mode = RANK_MODES[m];
        list.sort(
          (a, b) =>
            rankScore(ivSum(b.iv), b.pv, b.reversers, mode) - rankScore(ivSum(a.iv), a.pv, a.reversers, mode),
        );
        list.length = KEEP_PER_SIZE;
      }
    }
  };

  // Seed best-first so ties resolve toward higher talent sums.
  const sortedOwned = [...owned].sort(
    (a, b) => b.ivHp + b.ivAttack + b.ivDefense - (a.ivHp + a.ivAttack + a.ivDefense),
  );
  for (const pal of sortedOwned) {
    const i = speciesIndexOf(pal.characterId);
    if (i === undefined) continue;
    let m0 = 0;
    let m1 = 0;
    let m2 = 0;
    let m3 = 0;
    for (const code of pal.passives ?? []) {
      const bit = bitOf.get(code);
      if (bit === undefined) continue;
      const flag = 1 << bit % 32;
      if (bit < 32) m0 |= flag;
      else if (bit < 64) m1 |= flag;
      else if (bit < 96) m2 |= flag;
      else m3 |= flag;
    }
    insert(i, {
      gen: 0,
      iv: [pal.ivHp, pal.ivAttack, pal.ivDefense],
      m0,
      m1,
      m2,
      m3,
      pv: passiveValue(m0, m1, m2, m3),
      size: 0,
      reversers: 0,
      grp: pal.gender || "unknown",
      leaf: pal,
    });
  }

  // Earliest generation each species can exist at:
  // dist[c] = min over pairs of max(dist[a], dist[b]) + 1.
  const INF = 0x3fffffff;
  const dist = new Int32Array(n).fill(INF);
  for (let i = 0; i < n; i++) if (byGen[i][0]) dist[i] = 0; // a bucket exists only once seeded
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < n; i++) {
      if (dist[i] >= INF) continue;
      for (let j = i; j < n; j++) {
        if (dist[j] >= INF) continue;
        const d = Math.max(dist[i], dist[j]) + 1;
        const c1 = childOfPair(i, j);
        if (c1 < 0) continue;
        if (d < dist[c1]) {
          dist[c1] = d;
          changed = true;
        }
        const c2 = altChildOfPair(i, j);
        if (c2 >= 0 && d < dist[c2]) {
          dist[c2] = d;
          changed = true;
        }
      }
    }
  }
  if (dist[target] >= INF) return { status: "unreachable" };

  const cap = dist[target] + EXTRA_GENERATIONS;

  // Fewest generations from a species to the target, treating any reachable
  // species as an eligible partner regardless of timing — a lower bound, so
  // pruning on dist[s] + up[s] > cap never cuts a real route.
  const up = new Int32Array(n).fill(INF);
  up[target] = 0;
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < n; i++) {
      if (dist[i] >= INF) continue;
      for (let j = i; j < n; j++) {
        if (dist[j] >= INF) continue;
        const c1 = childOfPair(i, j);
        if (c1 < 0) continue;
        const c2 = altChildOfPair(i, j);
        const through = Math.min(up[c1], c2 >= 0 ? up[c2] : INF) + 1;
        if (through < up[i]) {
          up[i] = through;
          changed = true;
        }
        if (through < up[j]) {
          up[j] = through;
          changed = true;
        }
      }
    }
  }

  const useful = (s: number) => dist[s] + up[s] <= cap;

  for (let r = 1; r <= cap; r++) {
    for (let i = 0; i < n; i++) {
      if (dist[i] >= r || !useful(i)) continue; // nothing below generation r, or off-route
      for (let j = i; j < n; j++) {
        if (dist[j] >= r || !useful(j)) continue;
        const c1 = childOfPair(i, j);
        if (c1 < 0) continue;
        const c2 = altChildOfPair(i, j);
        // A child born this round still has to reach the target in budget.
        const want1 = r + up[c1] <= cap;
        const want2 = c2 >= 0 && r + up[c2] <= cap;
        if (!want1 && !want2) continue;
        // A generation-r child needs one parent at exactly r-1 and the other
        // anywhere at or below it. Within one species the pair is unordered,
        // so only walk one orientation (and one triangle at ga === gb).
        const combine = (listA: Entry<P>[] | undefined, listB: Entry<P>[] | undefined) => {
          if (!listA?.length || !listB?.length) return;
          const triangle = listA === listB;
          for (let x = 0; x < listA.length; x++) {
            const ea = listA[x];
            for (let y = triangle ? x : 0; y < listB.length; y++) {
              const eb = listB[y];
              // A pal can't breed with itself; two pals of one species can.
              if (ea.leaf && eb.leaf && ea.leaf.key === eb.leaf.key) continue;
              const iv: Ceiling = [
                Math.max(ea.iv[0], eb.iv[0]),
                Math.max(ea.iv[1], eb.iv[1]),
                Math.max(ea.iv[2], eb.iv[2]),
              ];
              const m0 = ea.m0 | eb.m0;
              const m1 = ea.m1 | eb.m1;
              const m2 = ea.m2 | eb.m2;
              const m3 = ea.m3 | eb.m3;
              const pv = passiveValue(m0, m1, m2, m3);
              const size = ea.size + eb.size + 1;
              const reversers =
                ea.reversers +
                eb.reversers +
                (ea.leaf && eb.leaf && ea.leaf.gender && ea.leaf.gender === eb.leaf.gender ? 1 : 0);
              if (want1) {
                const cand: Entry<P> = {
                  gen: r,
                  iv,
                  m0,
                  m1,
                  m2,
                  m3,
                  pv,
                  size,
                  reversers,
                  grp: BRED_GROUP,
                  pair: { ai: i, a: ea, bi: j, b: eb, ci: c1 },
                };
                insert(c1, cand);
                if (c1 === target) offer(cand);
              }
              if (want2) {
                const cand: Entry<P> = {
                  gen: r,
                  iv,
                  m0,
                  m1,
                  m2,
                  m3,
                  pv,
                  size,
                  reversers,
                  grp: BRED_GROUP,
                  pair: { ai: i, a: ea, bi: j, b: eb, ci: c2 },
                };
                insert(c2, cand);
                if (c2 === target) offer(cand);
              }
            }
          }
        };
        for (let g = 0; g <= r - 1; g++) {
          combine(membersOf(byGen[i][g]), membersOf(byGen[j][r - 1]));
        }
        if (i !== j) {
          for (let g = 0; g <= r - 2; g++) {
            combine(membersOf(byGen[i][r - 1]), membersOf(byGen[j][g]));
          }
        }
      }
    }
  }

  // Reconstruction merges reused subtrees, so a kept tree's egg count only
  // settles here — bucket by what came out, then keep the cheapest few counts.
  const seenRoute = new Set<string>();
  const byEggs = new Map<number, RouteOption<P>[]>();
  for (const perSize of kept) {
    for (const list of perSize) {
      for (const entry of list ?? []) {
        const option = reconstruct(entry, maskCodes(entry));
        if (seenRoute.has(option.id)) continue;
        seenRoute.add(option.id);
        const bucket = byEggs.get(option.eggs);
        if (bucket) bucket.push(option);
        else byEggs.set(option.eggs, [option]);
      }
    }
  }
  const buckets: RouteBucket<P>[] = [...byEggs.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, BUCKETS)
    .map(([eggs, routes]) => ({ eggs, routes }));

  // The 0-egg answer: the best copy already in the box, if there is one.
  let ownedBest: Entry<P> | undefined;
  for (const entry of membersOf(byGen[target][0]) ?? []) {
    if (!entry.leaf) continue;
    if (
      !ownedBest ||
      rankScore(ivSum(entry.iv), entry.pv, 0, "balanced") > rankScore(ivSum(ownedBest.iv), ownedBest.pv, 0, "balanced")
    )
      ownedBest = entry;
  }

  return {
    status: "ok",
    ...(ownedBest ? { owned: reconstruct(ownedBest, maskCodes(ownedBest)) } : {}),
    buckets,
  };
}

/** Passives a route names on the board — the four a pal can actually hold at
 * once, which is also the set its {@link RouteOption.passiveScore} is built
 * from. The rest of the pool is summarised as a count. */
export const HELD_PASSIVES = 4;

/**
 * Everything about a route the board puts on screen: the species pairings, the
 * ceilings, the four passives it names and how many more are in the pool. Two
 * routes with the same key would render as the same line — they differ only in
 * which individual pals fill the slots, which the step list below spells out
 * once a row is picked.
 */
function outcomeKey<P extends PathPal>(route: RouteOption<P>): string {
  const speciesOf = (parent: StepParent<P>) =>
    parent.kind === "owned" ? parent.pal.characterId : `egg${parent.n}`;
  const shape = route.steps
    .map((s) => `${s.childId}:${[speciesOf(s.a), speciesOf(s.b)].sort().join("+")}`)
    .join(">");
  const held = route.passives.slice(0, HELD_PASSIVES).join(",");
  return `${shape}|${route.ceiling.join("/")}|${route.reversers}|${held}|${route.passives.length}`;
}

/**
 * The board's ordering for one egg bucket. Routes that skip the Pal Reverser
 * are never shut out: if the whole top slice needs one and a Reverser-free
 * route exists, it takes the last slot — the alternative is usually worth more
 * than the fifth-best variation on the same pairing.
 *
 * Ceilings tie constantly on a well-stocked save, so the tie-breaks carry real
 * weight. The important one is pool size: two routes that reach the same best
 * four passives are not equally good if one drags nine others along, because
 * the child draws its four from the whole pool. Smaller pool, better odds.
 *
 * Returns fewer than `limit` rather than padding the column with routes that
 * would read identically — a short column is the honest answer to "there are
 * only three meaningfully different ways to do this".
 */
export function rankRoutes<P extends PathPal>(
  routes: RouteOption<P>[],
  mode: RankMode,
  limit: number,
): RouteOption<P>[] {
  const sorted = [...routes].sort((a, b) => {
    const d =
      rankScore(ivSum(b.ceiling), b.passiveScore, b.reversers, mode) -
      rankScore(ivSum(a.ceiling), a.passiveScore, a.reversers, mode);
    if (d !== 0) return d;
    if (a.reversers !== b.reversers) return a.reversers - b.reversers;
    if (a.passives.length !== b.passives.length) return a.passives.length - b.passives.length;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const top: RouteOption<P>[] = [];
  const shown = new Set<string>();
  for (const option of sorted) {
    if (top.length >= limit) break;
    const key = outcomeKey(option);
    if (shown.has(key)) continue;
    shown.add(key);
    top.push(option);
  }
  if (top.length === limit && top.every((r) => r.reversers > 0)) {
    const free = sorted.find((r) => r.reversers === 0);
    if (free) top[limit - 1] = free;
  }
  return top;
}

/** Unfold an entry into breed-order steps, merging identical subtrees — a pal
 * hatched once can parent any number of later pairs. */
function reconstruct<P extends PathPal>(entry: Entry<P>, passives: string[]): RouteOption<P> {
  if (entry.leaf)
    return {
      id: `L${entry.leaf.key}`,
      eggs: 0,
      ceiling: entry.iv,
      steps: [],
      ownedTarget: entry.leaf,
      reversers: 0,
      passives,
      passiveScore: entry.pv,
    };

  const steps: BreedStep<P>[] = [];
  const seen = new Map<string, number>();
  const build = (e: Entry<P>): { ref: StepParent<P>; sig: string } => {
    if (e.leaf) return { ref: { kind: "owned", pal: e.leaf }, sig: `L${e.leaf.key}` };
    const { ai, a, bi, b, ci } = e.pair!;
    const ra = build(a);
    let rb = build(b);
    if (ra.sig === rb.sig && ra.ref.kind === "egg") {
      // Both slots resolved to the same hatched pal, which can't breed with
      // itself — run its parents' pairing once more for a second copy.
      const orig = steps[ra.ref.n - 1];
      const copySig = `${ra.sig}#2`;
      let copyN = seen.get(copySig);
      if (copyN === undefined) {
        copyN = steps.length + 1;
        steps.push({ ...orig, n: copyN });
        seen.set(copySig, copyN);
      }
      rb = { ref: { kind: "egg", n: copyN, speciesId: orig.childId }, sig: copySig };
    }
    const speciesId = SPECIES_IDS[ci];
    const sig = `B${ci}(${ra.sig}|${rb.sig})`;
    let num = seen.get(sig);
    if (num === undefined) {
      num = steps.length + 1;
      steps.push({
        n: num,
        childId: speciesId,
        special: isSpecialPair(ai, bi),
        ceiling: e.iv,
        a: ra.ref,
        b: rb.ref,
      });
      seen.set(sig, num);
    }
    return { ref: { kind: "egg", n: num, speciesId }, sig };
  };
  const root = build(entry);
  // Counted after subtree merging, so a reused pairing is one Reverser.
  const reversers = steps.filter(
    (st) => st.a.kind === "owned" && st.b.kind === "owned" && st.a.pal.gender && st.a.pal.gender === st.b.pal.gender,
  ).length;
  return {
    id: root.sig,
    eggs: steps.length,
    ceiling: entry.iv,
    steps,
    reversers,
    passives,
    passiveScore: entry.pv,
  };
}
