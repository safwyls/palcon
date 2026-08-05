import { describe, expect, it } from "vitest";
import { DEFAULT_MAP_AREA, MAP_AREAS, MAP_AREA_ORDER, mapOf, worldToMapPercent } from "./map";

describe("MAP_AREAS", () => {
  it("keys Tree first, which is what gives it map priority", () => {
    // mapOf relies on this object's key order for the game's
    // WorldMapPriority 1 — where the boxes overlap, Tree wins.
    expect(Object.keys(MAP_AREAS)[0]).toBe("Tree");
  });

  it("orders the UI switcher with the main map first, a separate concern", () => {
    expect(MAP_AREA_ORDER).toEqual(["MainMap", "Tree"]);
    expect(DEFAULT_MAP_AREA).toBe("MainMap");
  });
});

describe("mapOf", () => {
  it("places a point that belongs to only one area", () => {
    const main = MAP_AREAS.MainMap;
    expect(mapOf((main.min.x + main.max.x) / 2, (main.min.y + main.max.y) / 2)).toBe("MainMap");

    const tree = MAP_AREAS.Tree;
    expect(mapOf((tree.min.x + tree.max.x) / 2, (tree.min.y + tree.max.y) / 2)).toBe("Tree");
  });

  it("gives Tree priority in the sliver where the two boxes overlap", () => {
    // The boxes meet only in x [347351.5, 349400] x y [-724400, -476400].
    // A point there is inside both, and the game's WorldMapPriority says
    // Tree wins.
    const tree = MAP_AREAS.Tree;
    const main = MAP_AREAS.MainMap;
    const x = (Math.max(tree.min.x, main.min.x) + Math.min(tree.max.x, main.max.x)) / 2;
    const y = (Math.max(tree.min.y, main.min.y) + Math.min(tree.max.y, main.max.y)) / 2;

    const inBox = (a: typeof main) => x >= a.min.x && x <= a.max.x && y >= a.min.y && y <= a.max.y;
    expect(inBox(main)).toBe(true);
    expect(inBox(tree)).toBe(true);
    expect(mapOf(x, y)).toBe("Tree");
  });

  it("falls back to the main map rather than vanishing a stray coordinate", () => {
    expect(mapOf(1e9, 1e9)).toBe("MainMap");
    expect(mapOf(-1e9, -1e9)).toBe("MainMap");
  });
});

describe("worldToMapPercent", () => {
  it("swaps the axes: the map's horizontal axis is world +Y", () => {
    const { min, max } = MAP_AREAS.MainMap;
    const left = worldToMapPercent(min.x, min.y, "MainMap");
    const right = worldToMapPercent(min.x, max.y, "MainMap");
    // Moving along world Y moves horizontally on the map, not vertically.
    expect(right.xPct).toBeGreaterThan(left.xPct);
    expect(right.yPct).toBeCloseTo(left.yPct, 6);
  });

  it("flips Y, because the raw formula is y-up and CSS top is y-down", () => {
    // Skipping this flip mirrors every player north-south — plausible-looking
    // but wrong positions rather than an obvious crash.
    const { min, max } = MAP_AREAS.MainMap;
    const lowX = worldToMapPercent(min.x, min.y, "MainMap");
    const highX = worldToMapPercent(max.x, min.y, "MainMap");
    expect(lowX.yPct).toBeGreaterThan(highX.yPct);
  });

  it("puts the area's min corner at the bottom-left of the map", () => {
    const { min } = MAP_AREAS.MainMap;
    const corner = worldToMapPercent(min.x, min.y, "MainMap");
    expect(corner.xPct).toBeCloseTo(0, 6);
    expect(corner.yPct).toBeCloseTo(100, 6);
  });

  it("keeps in-bounds points within 0-100% for both areas", () => {
    for (const area of MAP_AREA_ORDER) {
      const { min, max } = MAP_AREAS[area];
      for (const [x, y] of [
        [min.x, min.y],
        [max.x, max.y],
        [(min.x + max.x) / 2, (min.y + max.y) / 2],
      ]) {
        const { xPct, yPct } = worldToMapPercent(x, y, area);
        expect(xPct).toBeGreaterThanOrEqual(-0.001);
        expect(yPct).toBeGreaterThanOrEqual(-0.001);
        expect(xPct).toBeLessThanOrEqual(100.001);
        expect(yPct).toBeLessThanOrEqual(100.001);
      }
    }
  });
});
