import { describe, expect, it } from "vitest";
import {
  baseStats,
  computeStats,
  friendshipRank,
  hasCombatStats,
  passiveAffectsStats,
  passiveStatEffect,
  powerScore,
  talentRating,
  talentTone,
} from "./stats";

const ALPACA = "Alpaca";

/** A level-50 pal with flat-zero talents and no upgrades. */
function plain(overrides: Partial<Parameters<typeof computeStats>[0]> = {}) {
  return computeStats({
    characterId: ALPACA,
    level: 50,
    ivHp: 0,
    ivAttack: 0,
    ivDefense: 0,
    ...overrides,
  })!;
}

describe("baseStats / hasCombatStats", () => {
  it("reads the catalog through the canonicalized key", () => {
    const b = baseStats(ALPACA)!;
    expect(b.hp).toBeGreaterThan(0);
    expect(baseStats("BOSS_Alpaca")).toEqual(b);
    expect(hasCombatStats(ALPACA)).toBe(true);
  });

  it("returns null for a species with no combat data", () => {
    expect(baseStats("NotAPalAtAll")).toBeNull();
    expect(hasCombatStats("NotAPalAtAll")).toBe(false);
    expect(computeStats({ characterId: "NotAPalAtAll", level: 1, ivHp: 0, ivAttack: 0, ivDefense: 0 })).toBeNull();
  });
});

describe("passive stat effects", () => {
  it("recognises a stat-moving passive", () => {
    expect(passiveAffectsStats("Legend")).toBe(true);
    expect(passiveStatEffect("Legend")).toEqual([20, 20, 0]);
  });

  it("ignores passives that don't touch displayed stats", () => {
    expect(passiveAffectsStats("NotARealPassive")).toBe(false);
    expect(passiveStatEffect("NotARealPassive")).toBeNull();
  });

  it("stacks same-stat passives additively, not multiplicatively", () => {
    // Legend +20% def and defense_ACC_up3 +20% def give +40%, not x1.44.
    const none = plain();
    const both = plain({ passives: ["Legend", "defense_ACC_up3"] });
    const expected = Math.floor((none.defense / 1) * 1.4);
    // Compare against the additive prediction within rounding slack; the
    // multiplicative reading (x1.44) would be ~3% higher and fail this.
    expect(both.defense).toBeGreaterThanOrEqual(expected - 2);
    expect(both.defense).toBeLessThanOrEqual(expected + 2);
  });
});

describe("computeStats", () => {
  it("grows every stat with level", () => {
    const low = plain({ level: 1 });
    const high = plain({ level: 50 });
    expect(high.hp).toBeGreaterThan(low.hp);
    expect(high.attack).toBeGreaterThan(low.attack);
    expect(high.defense).toBeGreaterThan(low.defense);
  });

  it("treats level 0 or negative as level 1", () => {
    expect(plain({ level: 0 })).toEqual(plain({ level: 1 }));
    expect(plain({ level: -5 })).toEqual(plain({ level: 1 }));
  });

  it("makes perfect talents worth up to +30%", () => {
    const zero = plain({ level: 50, ivAttack: 0 });
    const perfect = plain({ level: 50, ivAttack: 100 });
    // The +30% applies to the level-scaled term, not the flat base, so the
    // total rises by less than 30% — but strictly.
    expect(perfect.attack).toBeGreaterThan(zero.attack);
  });

  it("clamps talents, souls and condenser to their legal ranges", () => {
    expect(plain({ ivHp: 500 })).toEqual(plain({ ivHp: 100 }));
    expect(plain({ ivHp: -50 })).toEqual(plain({ ivHp: 0 }));
    expect(plain({ soulHp: 99 })).toEqual(plain({ soulHp: 20 }));
    expect(plain({ condenser: 99 })).toEqual(plain({ condenser: 4 }));
  });

  it("multiplies for condenser stars and souls", () => {
    const none = plain();
    expect(plain({ condenser: 4 }).hp).toBeGreaterThan(none.hp);
    expect(plain({ soulAttack: 20 }).attack).toBeGreaterThan(none.attack);
    // Condenser applies to all three stats.
    expect(plain({ condenser: 4 }).defense).toBeGreaterThan(none.defense);
  });

  it("gives an alpha an HP-only bonus", () => {
    const normal = plain();
    const alpha = plain({ isAlpha: true });
    expect(alpha.hp).toBeGreaterThan(normal.hp);
    expect(alpha.attack).toBe(normal.attack);
    expect(alpha.defense).toBe(normal.defense);
  });

  it("returns whole numbers", () => {
    const s = plain({ ivHp: 73, condenser: 3, soulHp: 7, trust: 5 });
    expect(Number.isInteger(s.hp)).toBe(true);
    expect(Number.isInteger(s.attack)).toBe(true);
    expect(Number.isInteger(s.defense)).toBe(true);
  });
});

describe("friendshipRank", () => {
  it("maps accumulated bond points onto the rank the game shows", () => {
    expect(friendshipRank(0)).toBe(0);
    expect(friendshipRank(5999)).toBe(0);
    expect(friendshipRank(6000)).toBe(1);
    expect(friendshipRank(200000)).toBe(10);
    expect(friendshipRank(999999)).toBe(10); // never past the top rank
  });
});

describe("powerScore", () => {
  it("scales HP back into base-stat units so it can't decide every ranking", () => {
    // HP runs to five figures while attack/defense sit in the hundreds.
    expect(powerScore({ hp: 10000, attack: 500, defense: 400 })).toBeCloseTo(2400, 6);
  });

  it("orders a strictly better pal above a worse one", () => {
    const weak = powerScore({ hp: 5000, attack: 300, defense: 200 });
    const strong = powerScore({ hp: 6000, attack: 400, defense: 300 });
    expect(strong).toBeGreaterThan(weak);
  });
});

describe("talentTone", () => {
  it("reserves gold for a perfect 100 and green for breeding stock", () => {
    expect(talentTone(100)).toBe("#D4A017");
    expect(talentTone(99)).toBe("#4A9D7C");
    expect(talentTone(70)).toBe("#4A9D7C");
    expect(talentTone(69)).toBe("#5B9BD5");
    expect(talentTone(0)).toBe("#5B9BD5");
  });
});

describe("talentRating", () => {
  it("tiers on the average of the three talents", () => {
    expect(talentRating(100, 100, 100)).toEqual({ tier: "S", average: 100 });
    expect(talentRating(90, 90, 90)).toEqual({ tier: "S", average: 90 });
    expect(talentRating(70, 70, 70)).toEqual({ tier: "A", average: 70 });
    expect(talentRating(50, 50, 50)).toEqual({ tier: "B", average: 50 });
    expect(talentRating(30, 30, 30)).toEqual({ tier: "C", average: 30 });
    expect(talentRating(0, 0, 0)).toEqual({ tier: "D", average: 0 });
  });

  it("clamps out-of-range talents before averaging", () => {
    expect(talentRating(200, 100, 100).average).toBe(100);
    expect(talentRating(-50, 0, 0).average).toBe(0);
  });
});
