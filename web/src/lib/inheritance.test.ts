import { describe, expect, it } from "vitest";
import { eggsForConfidence, expectedEggs, passiveOdds, singlePassiveOdds } from "./inheritance";

describe("passiveOdds", () => {
  // The module's own documented sanity anchors: with the pool holding only
  // the desired passives, exact-set odds are 40/24/12/10% for 1-4 desired.
  it("matches the documented anchors for a pool of exactly the desired passives", () => {
    expect(passiveOdds(1, 1)!.exact).toBeCloseTo(0.4, 10);
    expect(passiveOdds(2, 2)!.exact).toBeCloseTo(0.24, 10);
    expect(passiveOdds(3, 3)!.exact).toBeCloseTo(0.12, 10);
    expect(passiveOdds(4, 4)!.exact).toBeCloseTo(0.1, 10);
  });

  it("explains 2-of-2 as 60% inherit-both x 40% no-stray", () => {
    const odds = passiveOdds(2, 2)!;
    expect(odds.atLeast).toBeCloseTo(0.6, 10);
    expect(odds.exact).toBeCloseTo(odds.atLeast * 0.4, 10);
  });

  it("charges no stray penalty at the 4-passive cap, where nothing can be added", () => {
    const four = passiveOdds(4, 4)!;
    expect(four.exact).toBeCloseTo(four.atLeast, 10);
  });

  it("returns null for an impossible ask", () => {
    expect(passiveOdds(4, 5)).toBeNull(); // more than the 4-slot cap
    expect(passiveOdds(2, 3)).toBeNull(); // passives the parents don't have
    expect(passiveOdds(2, -1)).toBeNull();
  });

  it("treats an empty pool as 'no passives', which only the random roll can spoil", () => {
    expect(passiveOdds(0, 0)).toEqual({ exact: 0.4, atLeast: 1 });
  });

  it("cannot produce a bare child from a non-empty pool", () => {
    // A non-empty pool always contributes at least one inherited passive.
    expect(passiveOdds(3, 0)).toEqual({ exact: 0, atLeast: 1 });
  });

  it("gets harder to hit an exact set as the pool grows past it", () => {
    const tight = passiveOdds(2, 2)!;
    const diluted = passiveOdds(4, 2)!;
    expect(diluted.exact).toBeLessThan(tight.exact);
    expect(diluted.atLeast).toBeLessThan(tight.atLeast);
  });

  it("keeps every probability inside [0,1] across the whole domain", () => {
    for (let pool = 0; pool <= 8; pool++) {
      for (let want = 0; want <= Math.min(pool, 4); want++) {
        const odds = passiveOdds(pool, want)!;
        expect(odds.exact).toBeGreaterThanOrEqual(0);
        expect(odds.atLeast).toBeLessThanOrEqual(1);
        expect(odds.exact).toBeLessThanOrEqual(odds.atLeast + 1e-12);
      }
    }
  });
});

describe("singlePassiveOdds", () => {
  it("is certain when the pool holds only that passive", () => {
    expect(singlePassiveOdds(1)).toBeCloseTo(1, 10);
  });

  it("thins out as the pool grows", () => {
    expect(singlePassiveOdds(2)).toBeCloseTo(0.8, 10);
    expect(singlePassiveOdds(4)).toBeCloseTo(0.5, 10);
    expect(singlePassiveOdds(8)).toBeLessThan(singlePassiveOdds(4));
  });

  it("is zero with nothing to inherit", () => {
    expect(singlePassiveOdds(0)).toBe(0);
  });
});

describe("eggsForConfidence", () => {
  it("needs four eggs for 90% confidence at even odds", () => {
    expect(eggsForConfidence(0.5)).toBe(4);
  });

  it("takes a certainty in one egg and an impossibility in none", () => {
    expect(eggsForConfidence(1)).toBe(1);
    expect(eggsForConfidence(0)).toBe(Infinity);
    expect(eggsForConfidence(-0.1)).toBe(Infinity);
  });

  it("respects a custom confidence", () => {
    expect(eggsForConfidence(0.5, 0.99)).toBe(7);
    expect(eggsForConfidence(0.5, 0.5)).toBe(1);
  });
});

describe("expectedEggs", () => {
  it("is the reciprocal of the per-egg chance", () => {
    expect(expectedEggs(0.25)).toBe(4);
    expect(expectedEggs(1)).toBe(1);
    expect(expectedEggs(0)).toBe(Infinity);
  });
});
