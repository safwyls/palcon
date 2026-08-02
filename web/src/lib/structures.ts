import structureCatalog from "../data/structures.json";

/**
 * Names for the placed objects that hold item containers.
 *
 * The names come from the game's own build menu, vendored the same way the item
 * catalog is (see docs/vendored-game-data.md). That matters more here than it
 * looks: hand-writing them from memory got several wrong in ways nobody would
 * catch from the UI — ItemChest_02 is "Metal Chest", not "Iron Chest", and
 * WorkBench_SkillUnlock is the Pal Gear Workbench, not anything to do with
 * skill fruit. A wrong name on this page sends someone to the wrong chest.
 *
 * What the catalog doesn't cover is the things that aren't buildings: the
 * world's treasure chests, items lying on the ground, and eggs sitting in the
 * wild. Those keep the hand-written names below, which is the easy half —
 * nobody has to find a treasure chest by name.
 */

const catalog = structureCatalog as Record<string, { n: string; c?: string; i?: string }>;

export type StructureRole = "storage" | "station" | "farm" | "loot" | "drop";

/**
 * The game's own build-menu category, mapped to the split this view cares
 * about: somewhere you put things, versus something that fills and empties on
 * its own. Both are searchable — ore genuinely does sit in furnaces — but they
 * answer different questions, so the view keeps them apart.
 *
 * Only the categories a container-bearing building can carry are listed;
 * anything else (walls, floors, decoration) never reaches this page, and
 * falls back to "storage" the way an unknown id does.
 */
const ROLE_BY_CATEGORY: Record<string, StructureRole> = {
  Infra_Storage: "storage", // the four chest tiers
  Infra_Environment: "storage", // barrels, shelves, the refrigerator
  Food_Basic: "storage", // feed boxes and the medicine rack: stocked by hand
  Food_Agriculture: "farm",
  Pal_Breed: "farm", // breeding farms and egg incubators
  Pal_Capture: "station", // sphere assembly lines
  Pal_Modify: "station",
  Prod_Craft: "station",
  Prod_Furnace: "station",
  Prod_Resource: "station", // ore pits, oil pumps, logging sites
  Prod_Medicine: "station",
  Infra_Medical: "station",
  Infra_GeneratePower: "station",
  Infra_Defense: "station",
  Other: "station", // the expedition station lives here
};

/**
 * The world's own objects, which aren't in the build menu and so aren't in the
 * catalog. Names here are ours; they only have to be recognisable, since these
 * are found by walking into them rather than by name.
 */
const WORLD_OBJECTS: Record<string, { name: string; role: StructureRole }> = {
  TreasureBox: { name: "Treasure chest", role: "loot" },
  TreasureBox_RequiredLongHold: { name: "Locked chest", role: "loot" },
  TreasureBox_Oilrig: { name: "Oil rig chest", role: "loot" },
  TreasureBox_Electric: { name: "Electric chest", role: "loot" },
  TreasureBox_Fire: { name: "Fire chest", role: "loot" },
  TreasureBox_Water: { name: "Water chest", role: "loot" },
  TreasureBox_FishingJunk_RequiredLongHold: { name: "Sunken crate", role: "loot" },
  TreasureBox_FishingJunk_RequiredLongHold2: { name: "Sunken crate", role: "loot" },
  // Not structures at all: an item lying where something dropped it, and an
  // egg the world spawned rather than a farm produced.
  CommonDropItem3D: { name: "Dropped item", role: "drop" },
  PalEgg_Leaf: { name: "Pal egg", role: "farm" },
  PalEgg_Earth: { name: "Pal egg", role: "farm" },
  PalEgg_Electricity: { name: "Pal egg", role: "farm" },
  PalEgg_Fire: { name: "Pal egg", role: "farm" },
  PalEgg_Water: { name: "Pal egg", role: "farm" },
  PalEgg_Ice: { name: "Pal egg", role: "farm" },
  PalEgg_Dark: { name: "Pal egg", role: "farm" },
  PalEgg_Dragon: { name: "Pal egg", role: "farm" },
  PalEgg_Normal: { name: "Pal egg", role: "farm" },
};

/** The name to show for a placed object. Falls back to a humanized id, so a
 * building added by a game update reads as something rather than nothing. */
export function structureName(objectId: string): string {
  const building = catalog[objectId];
  if (building) return building.n;
  const world = WORLD_OBJECTS[objectId];
  if (world) return world.name;
  // An empty id means the save named nothing — the container exists but no
  // surviving object claims it. "Container" rather than "Unplaced storage":
  // the group heading already says it's unplaced.
  if (!objectId) return "Container";
  return objectId
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
}

/**
 * The build-menu icon for a placed object, or "" when none is vendored.
 *
 * Only the buildings that can own an item container have icons here — a
 * foundation or a wall never reaches this view — so an empty string is the
 * normal answer for most of the catalog, not a failure. The world's own
 * treasure chests have none either: they aren't in the build menu.
 */
export function structureIconUrl(objectId: string): string {
  const icon = catalog[objectId]?.i;
  return icon ? `${import.meta.env.BASE_URL}structure-icons/${icon}.webp` : "";
}

/** What kind of thing it is, for grouping. Unknown ids are treated as storage:
 * a container we can't identify is likelier to be a new chest than a new
 * furnace, and over-listing it is the recoverable mistake. */
export function structureRole(objectId: string): StructureRole {
  const world = WORLD_OBJECTS[objectId];
  if (world) return world.role;
  const category = catalog[objectId]?.c;
  return (category && ROLE_BY_CATEGORY[category]) || "storage";
}

/** Section headings, in the order the page stacks them. */
export const ROLE_LABELS: Record<StructureRole, string> = {
  storage: "Storage",
  farm: "Farms & incubators",
  station: "Work stations",
  loot: "World loot",
  drop: "Dropped items",
};
