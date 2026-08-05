import { describe, expect, it } from "vitest";
import {
  ARENA_RANKS,
  ASTRALYM,
  BOSS_CHAIN,
  BOUNTY_ROSTER,
  EFFIGY_KINDS,
  PALPAGOS_TOWERS,
  RAID_ROSTER,
  arenaRank,
  bossLabel,
  bossesCleared,
  capturePower,
  effigyCounts,
  effigyIconUrl,
  extraTowerKeys,
  isLaboratory,
  mainQuests,
  questLabel,
  raidFight,
  raidPalId,
  recordName,
  splitFieldBosses,
  towerClears,
  towerFight,
} from "./achievements";

/** PlayerRecords is structural; the helpers only read these fields. */
function records(over: Partial<Parameters<typeof bossesCleared>[0]> = {}) {
  return { towers: [], towerCounts: {}, ...over } as Parameters<typeof bossesCleared>[0];
}

describe("BOSS_CHAIN", () => {
  it("runs in progression order, Palpagos towers first and Astralym last", () => {
    expect(BOSS_CHAIN[0]).toBe(PALPAGOS_TOWERS[0]);
    expect(BOSS_CHAIN[BOSS_CHAIN.length - 1]).toBe(ASTRALYM);
  });

  it("has no duplicate keys", () => {
    const keys = BOSS_CHAIN.map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("bossLabel", () => {
  it("prefers the boss's own name", () => {
    expect(bossLabel({ key: "K", name: "Zoe & Grizzbolt", palId: "GrassMammoth" })).toBe("Zoe & Grizzbolt");
  });

  it("falls back to the catalog name for the pal it's drawn as", () => {
    const boss = { key: "K", palId: "Alpaca" };
    expect(bossLabel(boss)).toBe(recordName("Alpaca"));
  });

  it("falls back to the raw key when there's nothing else", () => {
    expect(bossLabel({ key: "MysteryBoss" })).toBe("MysteryBoss");
  });
});

describe("isLaboratory", () => {
  it("singles out the fight that draws as a silhouette", () => {
    expect(isLaboratory({ key: "BOSS_BATTLE_NAME_WorldTreeMiddleBoss3" })).toBe(true);
    expect(isLaboratory({ key: "BOSS_BATTLE_NAME_Something" })).toBe(false);
  });
});

describe("towerFight / raidFight", () => {
  it("returns vendored stats for a known fight", () => {
    const known = BOSS_CHAIN.map((b) => towerFight(b.key)).find(Boolean);
    expect(known?.title).toBeTruthy();
  });

  it("is undefined for a fight with nothing vendored", () => {
    expect(towerFight("NoSuchTower")).toBeUndefined();
    expect(raidFight("NoSuchRaid")).toBeUndefined();
  });
});

describe("EFFIGY_KINDS", () => {
  it("joins all thirteen enum values to their pal and item", () => {
    expect(EFFIGY_KINDS).toHaveLength(13);
    expect(new Set(EFFIGY_KINDS.map((k) => k.type)).size).toBe(13);
    expect(new Set(EFFIGY_KINDS.map((k) => k.item)).size).toBe(13);
  });
});

describe("effigyIconUrl", () => {
  it("lowercases the item id, which is the icon convention", () => {
    expect(effigyIconUrl("Relic_04")).toContain("item-icons/relic_04.webp");
  });
});

describe("effigyCounts", () => {
  it("lists found kinds biggest first, skipping the empty ones", () => {
    // A row reading "Yakumo 0" is a slower way of saying nothing.
    const rows = effigyCounts({ JumpPower: 2, CapturePower: 5, SwimSpeed: 0 });
    expect(rows.map((r) => r.count)).toEqual([5, 2]);
    expect(rows[0].pal).toBe("Lifmunk");
    expect(rows.some((r) => r.pal === "Pengullet")).toBe(false);
  });

  it("shows an unrecognised kind under its raw enum name rather than dropping it", () => {
    const rows = effigyCounts({ BrandNewBonus: 3 });
    expect(rows).toEqual([{ pal: "BrandNewBonus", item: "Relic", count: 3 }]);
  });

  it("breaks count ties by name", () => {
    const rows = effigyCounts({ JumpPower: 1, CapturePower: 1 });
    expect(rows.map((r) => r.pal)).toEqual(["Lifmunk", "Rooby"]);
  });

  it("is empty when nothing was found", () => {
    expect(effigyCounts({})).toEqual([]);
  });
});

describe("capturePower", () => {
  it("reads the one relic bonus the inventory view leaves out", () => {
    expect(capturePower({ CapturePower: 7 })).toBe(7);
    expect(capturePower({})).toBe(0);
  });
});

describe("arenaRank", () => {
  it("reports the highest rank cleared", () => {
    expect(arenaRank({ Bronze: 1, Gold: 2 })).toBe("Gold");
    expect(arenaRank({ Master: 1, Bronze: 9 })).toBe("Master");
  });

  it("ignores ranks recorded as zero", () => {
    expect(arenaRank({ Bronze: 1, Master: 0 })).toBe("Bronze");
  });

  it("is null when none was cleared", () => {
    expect(arenaRank({})).toBeNull();
    expect(arenaRank({ Bronze: 0 })).toBeNull();
  });

  it("ladders from Bronze to Master", () => {
    expect(ARENA_RANKS[0]).toBe("Bronze");
    expect(ARENA_RANKS[ARENA_RANKS.length - 1]).toBe("Master");
  });
});

describe("RAID_ROSTER", () => {
  it("is ordered by vendored difficulty, not release order", () => {
    // Hartalis (70) sitting above Xenolord (65) is what showed the two
    // orders aren't the same thing.
    const levels = RAID_ROSTER.map((r) => raidFight(r.key)?.normal?.[0] ?? Number.MAX_SAFE_INTEGER);
    expect(levels).toEqual([...levels].sort((a, b) => a - b));
  });
});

describe("raidPalId", () => {
  it("maps a summon key onto the catalog's raid artwork", () => {
    expect(raidPalId("PalSummon_NightLady")).toBe("raid_nightlady");
  });

  it("degrades to the plain id when the catalog has no raid entry", () => {
    expect(raidPalId("PalSummon_BrandNewBoss")).toBe("BrandNewBoss");
  });
});

describe("BOUNTY_ROSTER", () => {
  it("derives the roster from the catalog rather than a typed list", () => {
    expect(BOUNTY_ROSTER.length).toBeGreaterThan(0);
    expect(BOUNTY_ROSTER.every((k) => k.startsWith("boss_"))).toBe(true);
  });

  it("excludes quest-spawned targets, expressed as a rule not a name", () => {
    expect(BOUNTY_ROSTER.some((k) => k.includes("_quest_"))).toBe(false);
  });
});

describe("splitFieldBosses", () => {
  it("separates named human bounties from field alpha spawn points", () => {
    const bounty = BOUNTY_ROSTER[0];
    const { bounties, fieldBosses } = splitFieldBosses([bounty.toUpperCase(), "81_1_grass_FBOSS_20"]);
    expect(bounties).toEqual([bounty]);
    expect(fieldBosses).toEqual(["81_1_grass_FBOSS_20"]);
  });

  it("treats a boss_-prefixed key the catalog doesn't know as a field boss", () => {
    const { bounties, fieldBosses } = splitFieldBosses(["boss_not_in_the_catalog"]);
    expect(bounties).toEqual([]);
    expect(fieldBosses).toEqual(["boss_not_in_the_catalog"]);
  });

  it("handles an empty flag list", () => {
    expect(splitFieldBosses([])).toEqual({ bounties: [], fieldBosses: [] });
  });
});

describe("bossesCleared", () => {
  it("counts only chain bosses, so it can't exceed its own denominator", () => {
    const two = BOSS_CHAIN.slice(0, 2).map((b) => b.key);
    expect(bossesCleared(records({ towers: [...two, "SomeUnknownBoss"] }))).toBe(2);
  });

  it("is zero for a player who has cleared nothing", () => {
    expect(bossesCleared(records())).toBe(0);
  });
});

describe("extraTowerKeys", () => {
  it("surfaces keys the chain doesn't account for, sorted", () => {
    const extras = extraTowerKeys(new Set([BOSS_CHAIN[0].key, "ZNewBoss", "ANewBoss"]));
    expect(extras).toEqual(["ANewBoss", "ZNewBoss"]);
  });

  it("is empty when the save holds only known bosses", () => {
    expect(extraTowerKeys(new Set(BOSS_CHAIN.map((b) => b.key)))).toEqual([]);
  });
});

describe("towerClears", () => {
  it("bridges the flag key to the differently-keyed count map", () => {
    const recs = records({ towerCounts: { PalTower_01_Normal: 3, PalTower_01_Hard: 1 } });
    expect(towerClears(recs, "BOSS_BATTLE_NAME_PalTower_01")).toEqual({ normal: 3, hard: 1 });
  });

  it("reports zeroes for a boss never fought", () => {
    expect(towerClears(records(), "BOSS_BATTLE_NAME_Whatever")).toEqual({ normal: 0, hard: 0 });
  });
});

describe("mainQuests / questLabel", () => {
  it("keeps only main-story quests out of the mixed completed list", () => {
    expect(mainQuests(["Main_A", "Sub_DeliveryWood_Fine", "Hidden_Tutorial", "Main_B"])).toEqual([
      "Main_A",
      "Main_B",
    ]);
  });

  it("reads a quest id as a sentence", () => {
    expect(questLabel("Main_DefeatSnowyMountainBoss")).toBe("Defeat Snowy Mountain Boss");
    expect(questLabel("Sub_DeliveryWood_Fine")).toBe("Delivery Wood Fine");
  });
});
