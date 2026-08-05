import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  GEAR_SLOTS,
  RARITY_COLORS,
  RARITY_NAMES,
  durabilityFraction,
  equipSlot,
  itemCategory,
  itemEntry,
  itemIconUrl,
  itemName,
  rarityColor,
  stackWeight,
} from "./items";

describe("itemName", () => {
  it("uses the localized name from the catalog", () => {
    expect(itemName("PalSphere_Mega")).toBe("Mega Sphere");
    expect(itemName("AncientArmor")).toBe("Ancient Armor");
  });

  it("humanizes an unknown id rather than dropping it", () => {
    // An item added by a game update still shows something readable.
    expect(itemName("SomeNewThing_Alpha")).toBe("Some New Thing Alpha");
    expect(itemName("PlainId")).toBe("Plain Id");
  });
});

describe("itemEntry / itemIconUrl", () => {
  it("returns the catalog row and an icon path", () => {
    expect(itemEntry("PalSphere_Mega")?.n).toBe("Mega Sphere");
    expect(itemIconUrl("PalSphere_Mega")).toContain("item-icons/palsphere_mega.webp");
  });

  it("gives no icon for an unknown item, rather than a broken path", () => {
    expect(itemEntry("NotAnItem")).toBeUndefined();
    expect(itemIconUrl("NotAnItem")).toBe("");
  });
});

describe("rarityColor", () => {
  it("colors only rarity 1 and up", () => {
    // Rarity 0 covers ore, wood and berries — outlining every slot would
    // make the outline meaningless.
    expect(rarityColor("PalSphere_Mega")).toBeUndefined(); // r: 0
    expect(rarityColor("Accessory_AT_1")).toBe(RARITY_COLORS[2]);
    expect(rarityColor("Accessory_AirDash3")).toBe(RARITY_COLORS[4]);
  });

  it("gives an unknown item no color", () => {
    expect(rarityColor("NotAnItem")).toBeUndefined();
  });

  it("names all five rungs of the ladder", () => {
    expect(Object.keys(RARITY_NAMES)).toHaveLength(5);
    expect(RARITY_NAMES[0]).toBe("Common");
    expect(RARITY_NAMES[4]).toBe("Legendary");
  });
});

describe("itemCategory", () => {
  it("folds the game's narrow types into the filter's coarser groups", () => {
    // SpecialWeapon is a one-or-two-item group; it belongs where a player
    // would look for it.
    expect(itemCategory("PalSphere_Mega")).toBe("Spheres");
    expect(itemCategory("AncientArmor")).toBe("Gear");
    expect(itemCategory("Accessory_AT_1")).toBe("Gear");
    expect(itemCategory("AIcore")).toBe("Materials");
  });

  it("buckets anything unrecognised as Other", () => {
    expect(itemCategory("NotAnItem")).toBe("Other");
  });

  it("offers every alias target in the filter list", () => {
    for (const id of ["PalSphere_Mega", "AncientArmor", "AIcore"]) {
      expect(CATEGORIES).toContain(itemCategory(id));
    }
  });
});

describe("equipSlot", () => {
  it("reports the socket the game racks an item in", () => {
    expect(equipSlot("AncientArmor")).toBe("Body");
    expect(equipSlot("Accessory_AT_1")).toBe("Accessory");
  });

  it("is undefined for anything not worn", () => {
    expect(equipSlot("AIcore")).toBeUndefined();
    expect(equipSlot("NotAnItem")).toBeUndefined();
  });

  it("lists only the single-socket slots, deliberately excluding accessories", () => {
    // How many accessories a player can wear varies with level and tech.
    expect(GEAR_SLOTS).not.toContain("Accessory");
    expect(GEAR_SLOTS).toContain("Body");
  });
});

describe("stackWeight", () => {
  it("multiplies unit weight by the count", () => {
    expect(stackWeight("AncientArmor", 2)).toBeCloseTo(80, 6);
    expect(stackWeight("PalSphere_Mega", 10)).toBeCloseTo(1, 6);
  });

  it("treats an unknown item as weightless rather than NaN", () => {
    expect(stackWeight("NotAnItem", 99)).toBe(0);
  });
});

describe("durabilityFraction", () => {
  it("reports wear as a fraction of the listed maximum", () => {
    expect(durabilityFraction("AncientArmor", 25000)).toBe(1);
    expect(durabilityFraction("AncientArmor", 12500)).toBeCloseTo(0.5, 6);
    expect(durabilityFraction("AncientArmor", 0)).toBe(0);
  });

  it("clamps a save written mid-repair, which can exceed the listed max", () => {
    expect(durabilityFraction("AncientArmor", 26000)).toBe(1);
    expect(durabilityFraction("AncientArmor", -5)).toBe(0);
  });

  it("is undefined when the item has no durability or none was recorded", () => {
    expect(durabilityFraction("PalSphere_Mega", 100)).toBeUndefined();
    expect(durabilityFraction("AncientArmor", undefined)).toBeUndefined();
    expect(durabilityFraction("NotAnItem", 10)).toBeUndefined();
  });
});
