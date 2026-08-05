import { describe, expect, it } from "vitest";
import { ROLE_LABELS, structureIconUrl, structureName, structureRole } from "./structures";

describe("structureName", () => {
  it("uses the game's own build-menu name", () => {
    // Hand-written names got several of these wrong in ways the UI would
    // never surface: ItemChest_02 is a Metal Chest, not an Iron Chest.
    expect(structureName("ItemChest_02")).toBe("Metal Chest");
    expect(structureName("BreedFarm")).toBe("Breeding Farm");
  });

  it("names the world's own objects, which aren't in the build menu", () => {
    expect(structureName("TreasureBox")).toBe("Treasure chest");
    expect(structureName("TreasureBox_FishingJunk_RequiredLongHold")).toBe("Sunken crate");
    expect(structureName("CommonDropItem3D")).toBe("Dropped item");
    expect(structureName("PalEgg_Dragon")).toBe("Pal egg");
  });

  it("calls an unnamed container just 'Container'", () => {
    // The group heading already says it's unplaced.
    expect(structureName("")).toBe("Container");
  });

  it("humanizes an id added by a game update", () => {
    expect(structureName("BrandNewThing_02")).toBe("Brand New Thing 02");
  });
});

describe("structureIconUrl", () => {
  it("points at the vendored build-menu icon", () => {
    expect(structureIconUrl("AncientBlastFurnace")).toContain("structure-icons/ancientblastfurnace.webp");
  });

  it("returns an empty string when none is vendored, which is normal", () => {
    // Treasure chests aren't in the build menu and have no icon.
    expect(structureIconUrl("TreasureBox")).toBe("");
    expect(structureIconUrl("NotAStructure")).toBe("");
  });
});

describe("structureRole", () => {
  it("separates places you put things from things that fill on their own", () => {
    expect(structureRole("ItemChest_02")).toBe("storage");
    expect(structureRole("AncientBlastFurnace")).toBe("station");
    expect(structureRole("AncientFarmBlock")).toBe("farm");
    expect(structureRole("BreedFarm")).toBe("farm");
  });

  it("classifies the world's objects from its own table", () => {
    expect(structureRole("TreasureBox")).toBe("loot");
    expect(structureRole("CommonDropItem3D")).toBe("drop");
    expect(structureRole("PalEgg_Fire")).toBe("farm");
  });

  it("treats an unknown container as storage, the recoverable mistake", () => {
    // Likelier to be a new chest than a new furnace, and over-listing it
    // is the error you can walk back.
    expect(structureRole("NotAStructure")).toBe("storage");
    expect(structureRole("")).toBe("storage");
  });
});

describe("ROLE_LABELS", () => {
  it("gives every role a section heading", () => {
    for (const role of ["storage", "farm", "station", "loot", "drop"] as const) {
      expect(ROLE_LABELS[role], role).toBeTruthy();
    }
  });
});
