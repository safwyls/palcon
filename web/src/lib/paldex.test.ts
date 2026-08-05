import { describe, expect, it } from "vitest";
import {
  DECK_BASE_ENTRIES,
  DECK_ENTRIES,
  DECK_UNCATCHABLE_ENTRIES,
  DECK_VARIANT_ENTRIES,
  UNCATCHABLE_DECK_LABELS,
  completionPct,
  palBaseStats,
  palDeckNo,
  palDeckSortValue,
  palEntry,
  palIconUrl,
  palKey,
  palName,
  passiveDescription,
  passiveName,
  passiveTier,
  passiveTierByName,
  rarityTier,
  skillDescription,
  skillName,
} from "./paldex";

describe("completionPct", () => {
  it("only reports 100 for genuine completion", () => {
    expect(completionPct(10, 10)).toBe(100);
    expect(completionPct(11, 10)).toBe(100);
  });

  it("never rounds up to 100 short of it", () => {
    // At 99.7% you have not finished; one rule beats a special case.
    expect(completionPct(999, 1000)).toBe(99);
    expect(completionPct(1, 1000)).toBe(0);
  });

  it("floors rather than rounds, so 49.7% is not half", () => {
    expect(completionPct(497, 1000)).toBe(49);
    expect(completionPct(1, 2)).toBe(50);
  });

  it("is zero for an empty universe", () => {
    expect(completionPct(0, 0)).toBe(0);
    expect(completionPct(5, -1)).toBe(0);
  });
});

describe("palKey / palEntry / palName", () => {
  it("canonicalizes capture decorations to the base species", () => {
    expect(palKey("BOSS_Alpaca")).toBe(palKey("Alpaca"));
    expect(palName("BOSS_Alpaca")).toBe(palName("Alpaca"));
  });

  it("falls back to the raw id when the catalog has no entry", () => {
    expect(palEntry("NotAPalAtAll")).toBeUndefined();
    expect(palName("NotAPalAtAll")).toBe("NotAPalAtAll");
  });

  it("builds an icon path from the canonical key", () => {
    expect(palIconUrl("BOSS_Alpaca")).toContain(`pal-icons/${palKey("Alpaca")}.webp`);
  });
});

describe("passiveName", () => {
  it("uses the localized name when the catalog has one", () => {
    expect(passiveName("Legend")).toBeTruthy();
  });

  it("humanizes a code the catalog only echoes back", () => {
    expect(passiveName("AccuracyDecrease")).toBe("Accuracy Decrease");
    expect(passiveName("Unique_WorldTreeDragon_BigBang")).toBe("World Tree Dragon Big Bang");
  });
});

describe("passiveTier", () => {
  it("ranks a Rainbow-tier passive above an ordinary one", () => {
    expect(passiveTier("Legend")).toBeGreaterThanOrEqual(4);
  });

  it("is 0 for codes the tier catalog doesn't cover", () => {
    expect(passiveTier("NotARealPassive")).toBe(0);
  });

  it("looks the same tier up by display name", () => {
    expect(passiveTierByName(passiveName("Legend"))).toBe(passiveTier("Legend"));
    expect(passiveTierByName("Not A Real Passive")).toBe(0);
  });
});

describe("passiveDescription / skillDescription", () => {
  it("returns nothing when the catalog just repeats the name", () => {
    expect(passiveDescription("NotARealPassive")).toBe("");
    expect(skillDescription("NotARealSkill")).toBe("");
  });

  it("humanizes an unknown skill code rather than showing it raw", () => {
    // One leading prefix is stripped, then separators and camelCase are
    // spaced out.
    expect(skillName("EPalWazaID::FooBar")).toBe("Foo Bar");
    expect(skillName("Unique_Foo_Bar")).toBe("Foo Bar");
  });
});

describe("palBaseStats", () => {
  it("returns hp and stomach for a catalogued species", () => {
    const s = palBaseStats("Alpaca");
    expect(s?.hp).toBeGreaterThan(0);
    expect(s?.stomach).toBeGreaterThan(0);
  });

  it("is undefined outside the catalog", () => {
    expect(palBaseStats("NotAPalAtAll")).toBeUndefined();
  });
});

describe("palDeckNo", () => {
  it("gives a species its Paldeck number", () => {
    expect(palDeckNo("Alpaca")).toMatch(/^\d+B?$/);
  });

  it("shows a captured variant under its species' number", () => {
    expect(palDeckNo("BOSS_Alpaca")).toBe(palDeckNo("Alpaca"));
  });

  it("is null for NPCs and unreleased pals", () => {
    expect(palDeckNo("NotAPalAtAll")).toBeNull();
  });
});

describe("palDeckSortValue", () => {
  it("orders 94 before 94B before 95", () => {
    const byLabel = new Map(DECK_ENTRIES.map((e) => [e.label, e.characterId]));
    const labels = [...byLabel.keys()];
    const base = labels.find((l) => /^\d+$/.test(l) && byLabel.has(`${l}B`))!;
    expect(base).toBeTruthy();

    const v = (label: string) => palDeckSortValue(byLabel.get(label)!);
    expect(v(base)).toBeLessThan(v(`${base}B`));
    const next = String(Number(base) + 1);
    if (byLabel.has(next)) expect(v(`${base}B`)).toBeLessThan(v(next));
  });

  it("sorts unnumbered entries last", () => {
    expect(palDeckSortValue("NotAPalAtAll")).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("DECK_ENTRIES", () => {
  it("is sorted naturally and has unique labels", () => {
    const labels = DECK_ENTRIES.map((e) => e.label);
    expect(new Set(labels).size).toBe(labels.length);
    const numbers = labels.map((l) => parseInt(l, 10));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
  });

  it("picks the plain species id, not a decorated spawn, to represent a label", () => {
    // The shortest id wins, so SUMMON_.../..._oilrig never becomes the face
    // of an entry.
    for (const entry of DECK_ENTRIES.slice(0, 40)) {
      expect(entry.characterId).not.toMatch(/^(SUMMON|PREDATOR|RAID)_/i);
    }
  });

  it("excludes uncatchable bosses from the completion universe", () => {
    // In the denominator they would put 100% permanently out of reach.
    const catchable = [...DECK_BASE_ENTRIES, ...DECK_VARIANT_ENTRIES];
    for (const label of Object.keys(UNCATCHABLE_DECK_LABELS)) {
      expect(catchable.some((e) => e.label === label)).toBe(false);
      expect(DECK_ENTRIES.some((e) => e.label === label)).toBe(true);
    }
    expect(DECK_UNCATCHABLE_ENTRIES).toHaveLength(Object.keys(UNCATCHABLE_DECK_LABELS).length);
  });

  it("splits base numbers from B-subspecies", () => {
    expect(DECK_BASE_ENTRIES.every((e) => /^\d+$/.test(e.label))).toBe(true);
    expect(DECK_VARIANT_ENTRIES.every((e) => !/^\d+$/.test(e.label))).toBe(true);
    expect(DECK_BASE_ENTRIES.length + DECK_VARIANT_ENTRIES.length + DECK_UNCATCHABLE_ENTRIES.length).toBe(
      DECK_ENTRIES.length,
    );
  });
});

describe("rarityTier", () => {
  it("uses the game's own 8+/12+ thresholds", () => {
    expect(rarityTier(0)).toBe("common");
    expect(rarityTier(7)).toBe("common");
    expect(rarityTier(8)).toBe("rare");
    expect(rarityTier(11)).toBe("rare");
    expect(rarityTier(12)).toBe("legendary");
  });
});
