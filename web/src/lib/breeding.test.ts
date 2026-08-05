import { describe, expect, it } from "vitest";
import {
  BREEDABLE,
  SPECIES_IDS,
  altChildOfPair,
  breedChild,
  childOfPair,
  isBreedable,
  isSpecialPair,
  parentPairsFor,
  speciesIndexOf,
} from "./breeding";

describe("speciesIndexOf", () => {
  it("finds an exact table id", () => {
    expect(speciesIndexOf("Alpaca")).toBe(SPECIES_IDS.indexOf("Alpaca"));
  });

  it("matches case-insensitively, since the table itself mixes cases", () => {
    // e.g. "Blueplatypus" vs "BluePlatypus_Fire".
    expect(speciesIndexOf("blueplatypus")).toBe(SPECIES_IDS.indexOf("Blueplatypus"));
    expect(speciesIndexOf("ALPACA")).toBe(speciesIndexOf("Alpaca"));
  });

  it("strips the decorations captured pals carry, which breed as their base species", () => {
    expect(speciesIndexOf("BOSS_Alpaca")).toBe(speciesIndexOf("Alpaca"));
    expect(speciesIndexOf("PREDATOR_MonochromeQueen")).toBe(speciesIndexOf("MonochromeQueen"));
    expect(speciesIndexOf("PlantSlime_Flower")).toBe(speciesIndexOf("PlantSlime"));
  });

  it("returns undefined for genuinely unbreedable ids", () => {
    // Humans and gym/raid/tower bosses never match a table row.
    expect(speciesIndexOf("NotAPalAtAll")).toBeUndefined();
    expect(speciesIndexOf("")).toBeUndefined();
  });
});

describe("childOfPair", () => {
  it("is symmetric, so A x B is the same as B x A", () => {
    const a = speciesIndexOf("Alpaca")!;
    const b = speciesIndexOf("Anubis")!;
    expect(childOfPair(a, b)).toBe(childOfPair(b, a));
    expect(childOfPair(a, b)).toBeGreaterThanOrEqual(0);
  });

  it("supports self-pairs", () => {
    const a = speciesIndexOf("Alpaca")!;
    expect(childOfPair(a, a)).toBeGreaterThanOrEqual(0);
  });
});

describe("breedChild", () => {
  it("returns the child of a plain pair", () => {
    const res = breedChild("Alpaca", "Anubis");
    expect(res).not.toBeNull();
    expect(SPECIES_IDS).toContain(res!.childId);
  });

  it("marks a hand-authored combo as special and honours its override", () => {
    // LazyDragon x ElecCat is one of the authored combos, whose child
    // replaces the formula's power-average result outright.
    const res = breedChild("LazyDragon", "ElecCat")!;
    expect(res.childId).toBe("LazyDragon_Electric");
    expect(res.special).toBe(true);
  });

  it("carries the alternate child for the game's one gender-dependent pair", () => {
    // CatMage x FoxMage (Katress x Wixen) hatches one of two children
    // depending on which parent is which gender.
    const res = breedChild("CatMage", "FoxMage")!;
    expect([res.childId, res.altChildId].sort()).toEqual(["CatMage_Fire", "FoxMage_Dark"]);
  });

  it("omits altChildId for every ordinary pair", () => {
    expect(breedChild("Alpaca", "Anubis")!.altChildId).toBeUndefined();
  });

  it("returns null when either parent is unbreedable", () => {
    expect(breedChild("Alpaca", "NotAPal")).toBeNull();
    expect(breedChild("NotAPal", "Alpaca")).toBeNull();
  });
});

describe("parentPairsFor", () => {
  it("finds pairs that breed into a target, special combos first", () => {
    const pairs = parentPairsFor("LazyDragon_Electric");
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.some((p) => p.aId === "ElecCat" && p.bId === "LazyDragon")).toBe(true);
    // Sorted so authored combos surface ahead of formula ones.
    const firstPlain = pairs.findIndex((p) => !p.special);
    if (firstPlain > 0) {
      expect(pairs.slice(0, firstPlain).every((p) => p.special)).toBe(true);
      expect(pairs.slice(firstPlain).every((p) => !p.special)).toBe(true);
    }
  });

  it("every reported pair really does breed into the target", () => {
    const target = speciesIndexOf("LazyDragon_Electric")!;
    for (const p of parentPairsFor("LazyDragon_Electric")) {
      const i = speciesIndexOf(p.aId)!;
      const j = speciesIndexOf(p.bId)!;
      expect(childOfPair(i, j) === target || altChildOfPair(i, j) === target).toBe(true);
    }
  });

  it("returns nothing for an unbreedable target", () => {
    expect(parentPairsFor("NotAPal")).toEqual([]);
  });
});

describe("isSpecialPair / isBreedable / BREEDABLE", () => {
  it("flags authored pairs only", () => {
    const lazy = speciesIndexOf("LazyDragon")!;
    const elec = speciesIndexOf("ElecCat")!;
    expect(isSpecialPair(lazy, elec)).toBe(true);
    expect(isSpecialPair(lazy, lazy)).toBe(false);
  });

  it("isBreedable tracks speciesIndexOf", () => {
    expect(isBreedable("Alpaca")).toBe(true);
    expect(isBreedable("BOSS_Alpaca")).toBe(true);
    expect(isBreedable("NotAPal")).toBe(false);
  });

  it("BREEDABLE lists every species, sorted by display name", () => {
    expect(BREEDABLE).toHaveLength(SPECIES_IDS.length);
    const names = BREEDABLE.map((p) => p.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});
