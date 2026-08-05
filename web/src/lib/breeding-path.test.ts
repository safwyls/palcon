import { describe, expect, it } from "vitest";
import { HELD_PASSIVES, type PathPal, type RouteOption, planRoutes, rankRoutes } from "./breeding-path";

/** LazyDragon x ElecCat is one of the game's authored combos. */
const PARENT_A = "LazyDragon";
const PARENT_B = "ElecCat";
const CHILD = "LazyDragon_Electric";

let nextKey = 0;
function pal(overrides: Partial<PathPal> & { characterId: string }): PathPal {
  return {
    key: `p${nextKey++}`,
    ivHp: 50,
    ivAttack: 50,
    ivDefense: 50,
    ...overrides,
  };
}

function planOk(owned: PathPal[], target: string) {
  const res = planRoutes(owned, target);
  if (res.status !== "ok") throw new Error(`expected ok, got ${res.status}`);
  return res;
}

describe("planRoutes", () => {
  it("reports an unbreedable target rather than searching for it", () => {
    expect(planRoutes([pal({ characterId: PARENT_A })], "NotAPalAtAll")).toEqual({
      status: "notBreedable",
    });
  });

  it("reports unreachable when nothing can be paired", () => {
    // A pal can't be paired with itself, so one owned pal breeds nothing.
    expect(planRoutes([pal({ characterId: PARENT_A })], CHILD)).toEqual({ status: "unreachable" });
    expect(planRoutes([], CHILD)).toEqual({ status: "unreachable" });
  });

  it("offers the copy already in the box as a zero-egg route", () => {
    const mine = pal({ characterId: CHILD, ivHp: 90, ivAttack: 80, ivDefense: 70 });
    const res = planOk([mine, pal({ characterId: PARENT_A })], CHILD);

    expect(res.owned).toBeDefined();
    expect(res.owned!.eggs).toBe(0);
    expect(res.owned!.steps).toEqual([]);
    expect(res.owned!.ownedTarget).toBe(mine);
    expect(res.owned!.ceiling).toEqual([90, 80, 70]);
  });

  it("picks the best owned copy when there are several", () => {
    const poor = pal({ characterId: CHILD, ivHp: 10, ivAttack: 10, ivDefense: 10 });
    const good = pal({ characterId: CHILD, ivHp: 100, ivAttack: 100, ivDefense: 100 });
    const res = planOk([poor, good], CHILD);
    expect(res.owned!.ownedTarget).toBe(good);
  });

  it("finds the one-egg route from two owned parents", () => {
    const a = pal({ characterId: PARENT_A });
    const b = pal({ characterId: PARENT_B });
    const res = planOk([a, b], CHILD);

    const cheapest = res.buckets[0];
    expect(cheapest.eggs).toBe(1);
    const route = cheapest.routes[0];
    expect(route.steps).toHaveLength(1);
    expect(route.steps[0].childId).toBe(CHILD);
    expect(route.steps[0].special).toBe(true);
    // Both parents are owned pals, named directly rather than as eggs.
    expect(route.steps[0].a.kind).toBe("owned");
    expect(route.steps[0].b.kind).toBe("owned");
  });

  it("carries the best talent of each parent into the ceiling", () => {
    // The ceiling is a best case per stat, taken across the derivation.
    const a = pal({ characterId: PARENT_A, ivHp: 100, ivAttack: 0, ivDefense: 40 });
    const b = pal({ characterId: PARENT_B, ivHp: 0, ivAttack: 100, ivDefense: 20 });
    const route = planOk([a, b], CHILD).buckets[0].routes[0];
    expect(route.ceiling[0]).toBe(100);
    expect(route.ceiling[1]).toBe(100);
    expect(route.ceiling[2]).toBe(40);
  });

  it("counts a Reverser when a step pairs two same-sex owned pals", () => {
    const a = pal({ characterId: PARENT_A, gender: "male" });
    const b = pal({ characterId: PARENT_B, gender: "male" });
    const route = planOk([a, b], CHILD).buckets[0].routes[0];
    expect(route.reversers).toBe(1);
  });

  it("charges no Reverser for an opposite-sex pairing", () => {
    const a = pal({ characterId: PARENT_A, gender: "male" });
    const b = pal({ characterId: PARENT_B, gender: "female" });
    const route = planOk([a, b], CHILD).buckets[0].routes[0];
    expect(route.reversers).toBe(0);
  });

  it("keeps a Reverser-free derivation alive through pruning", () => {
    // Champion criterion 4 makes fewest-Reversers dominant over talent sum
    // precisely so this route can't be pruned away by a same-sex sibling.
    // planRoutes doesn't order within a bucket — rankRoutes does — so the
    // guarantee is that the option survives and ranking surfaces it.
    const maleA = pal({ characterId: PARENT_A, gender: "male" });
    const femaleA = pal({ characterId: PARENT_A, gender: "female" });
    const maleB = pal({ characterId: PARENT_B, gender: "male" });
    const bucket = planOk([maleA, femaleA, maleB], CHILD).buckets[0];

    expect(bucket.routes.some((r) => r.reversers === 0)).toBe(true);
    expect(rankRoutes(bucket.routes, "balanced", 3)[0].reversers).toBe(0);
  });

  it("collects the passives a route can reach, best tier first", () => {
    const a = pal({ characterId: PARENT_A, passives: ["Legend"] });
    const b = pal({ characterId: PARENT_B, passives: ["Rare"] });
    const route = planOk([a, b], CHILD).buckets[0].routes[0];

    expect(route.passives).toContain("Legend");
    expect(route.passiveScore).toBeGreaterThan(0);
    // Sorted best-tier-first, so the four a pal can hold are the leading ones.
    expect(route.passives.length).toBeGreaterThanOrEqual(1);
  });

  it("scores a route with better passives above one without", () => {
    const withPassives = planOk(
      [pal({ characterId: PARENT_A, passives: ["Legend"] }), pal({ characterId: PARENT_B })],
      CHILD,
    ).buckets[0].routes[0];
    const without = planOk(
      [pal({ characterId: PARENT_A }), pal({ characterId: PARENT_B })],
      CHILD,
    ).buckets[0].routes[0];

    expect(withPassives.passiveScore).toBeGreaterThan(without.passiveScore);
    expect(without.passiveScore).toBe(0);
  });

  it("returns buckets in ascending egg order, cheapest first", () => {
    const owned = [
      pal({ characterId: PARENT_A }),
      pal({ characterId: PARENT_B }),
      pal({ characterId: "Alpaca" }),
      pal({ characterId: "Anubis" }),
    ];
    const res = planOk(owned, CHILD);
    const counts = res.buckets.map((b) => b.eggs);
    expect(counts).toEqual([...counts].sort((x, y) => x - y));
    expect(new Set(counts).size).toBe(counts.length);
    // Every route in a bucket really does cost that many eggs.
    for (const bucket of res.buckets) {
      for (const route of bucket.routes) expect(route.steps).toHaveLength(bucket.eggs);
    }
  });

  it("numbers steps in breed order, so no step depends on a later egg", () => {
    const owned = [
      pal({ characterId: PARENT_A }),
      pal({ characterId: PARENT_B }),
      pal({ characterId: "Alpaca" }),
      pal({ characterId: "Anubis" }),
    ];
    for (const bucket of planOk(owned, CHILD).buckets) {
      for (const route of bucket.routes) {
        route.steps.forEach((step, i) => {
          expect(step.n).toBe(i + 1);
          for (const parent of [step.a, step.b]) {
            if (parent.kind === "egg") expect(parent.n).toBeLessThan(step.n);
          }
        });
        // The last step produces the target.
        if (route.steps.length) expect(route.steps[route.steps.length - 1].childId).toBe(CHILD);
      }
    }
  });

  it("gives every route a distinct, stable id", () => {
    const owned = [pal({ characterId: PARENT_A }), pal({ characterId: PARENT_B })];
    const first = planOk(owned, CHILD);
    const again = planOk(owned, CHILD);
    const ids = first.buckets.flatMap((b) => b.routes.map((r) => r.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(again.buckets[0].routes[0].id).toBe(first.buckets[0].routes[0].id);
  });
});

describe("rankRoutes", () => {
  function route(over: Partial<RouteOption<PathPal>> & { id: string }): RouteOption<PathPal> {
    return {
      eggs: 1,
      ceiling: [50, 50, 50],
      steps: [],
      reversers: 0,
      passives: [],
      passiveScore: 0,
      ...over,
    };
  }

  it("leads with talents in talents mode", () => {
    const strong = route({ id: "a", ceiling: [100, 100, 100], passiveScore: 0 });
    const passive = route({ id: "b", ceiling: [10, 10, 10], passiveScore: 300 });
    expect(rankRoutes([passive, strong], "talents", 2)[0]).toBe(strong);
  });

  it("leads with passives in passives mode", () => {
    const strong = route({ id: "a", ceiling: [100, 100, 100], passiveScore: 0 });
    const passive = route({ id: "b", ceiling: [10, 10, 10], passiveScore: 300 });
    expect(rankRoutes([strong, passive], "passives", 2)[0]).toBe(passive);
  });

  it("weighs both axes in balanced mode and discounts a Reverser", () => {
    const clean = route({ id: "a", ceiling: [50, 50, 50], reversers: 0 });
    const needsReverser = route({ id: "b", ceiling: [50, 50, 55], reversers: 1 });
    // +5 talent doesn't pay for the Reverser errand, worth about 10.
    expect(rankRoutes([needsReverser, clean], "balanced", 2)[0]).toBe(clean);
  });

  it("honours the limit", () => {
    const routes = [1, 2, 3, 4, 5].map((i) => route({ id: `r${i}`, ceiling: [i, i, i] }));
    expect(rankRoutes(routes, "balanced", 3)).toHaveLength(3);
  });

  it("collapses routes that would render identically", () => {
    // Same shape, ceiling, reversers and passives — one line on the board.
    const a = route({ id: "a" });
    const b = route({ id: "b" });
    expect(rankRoutes([a, b], "balanced", 3)).toHaveLength(1);
  });

  it("gives a Reverser-free route the last slot rather than shutting it out", () => {
    const withReverser = [1, 2, 3].map((i) =>
      route({ id: `x${i}`, ceiling: [90 + i, 90, 90], reversers: 1 }),
    );
    const free = route({ id: "free", ceiling: [10, 10, 10], reversers: 0 });
    const top = rankRoutes([...withReverser, free], "talents", 3);
    expect(top).toHaveLength(3);
    expect(top).toContain(free);
  });

  it("returns fewer than the limit rather than padding with duplicates", () => {
    const a = route({ id: "a" });
    const b = route({ id: "b" });
    expect(rankRoutes([a, b], "balanced", 5).length).toBeLessThan(5);
  });

  it("does not mutate the caller's array", () => {
    const routes = [route({ id: "b", ceiling: [10, 10, 10] }), route({ id: "a", ceiling: [90, 90, 90] })];
    const order = routes.map((r) => r.id);
    rankRoutes(routes, "talents", 2);
    expect(routes.map((r) => r.id)).toEqual(order);
  });
});

describe("HELD_PASSIVES", () => {
  it("is the four slots a pal actually has", () => {
    expect(HELD_PASSIVES).toBe(4);
  });
});
