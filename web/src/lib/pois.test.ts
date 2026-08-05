import { afterEach, describe, expect, it, vi } from "vitest";
import { POI_KINDS, POI_META, POI_POINTS, loadPoiLayers, nearestLandmark, poiCount, savePoiLayers } from "./pois";
import { BOUNTY_POINTS, FIELD_BOSS_POINTS } from "./fieldBosses";

const STORAGE_KEY = "palcon-map-poi-layers";

describe("poiCount", () => {
  it("counts anonymous layers straight from the point table", () => {
    expect(poiCount("fastTravel")).toBe(POI_POINTS.fastTravel.length);
    expect(poiCount("dungeon")).toBe(POI_POINTS.dungeon.length);
  });

  it("takes field bosses and bounties from their own named table", () => {
    // The legend and the map would otherwise disagree: this file only ever
    // had anonymous coordinates for them.
    expect(poiCount("alpha")).toBe(FIELD_BOSS_POINTS.length);
    expect(poiCount("bounty")).toBe(BOUNTY_POINTS.length);
  });
});

describe("POI_META", () => {
  it("gives every layer a label and colour, so legend and pins agree", () => {
    for (const kind of POI_KINDS) {
      expect(POI_META[kind].label, kind).toBeTruthy();
      expect(POI_META[kind].color, kind).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});

describe("nearestLandmark", () => {
  it("finds the landmark at its own coordinates, zero metres away", () => {
    const named = POI_POINTS.fastTravel.find((p) => p.length === 3) as [number, number, string];
    const [x, y, name] = named;
    expect(nearestLandmark(x, y)).toEqual({ name, meters: 0 });
  });

  it("converts world units (centimetres) to metres", () => {
    const named = POI_POINTS.fastTravel.find((p) => p.length === 3) as [number, number, string];
    const [x, y] = named;
    // 100 world units along one axis is one metre.
    const near = nearestLandmark(x + 100, y)!;
    expect(near.meters).toBe(1);
  });

  it("always finds something, however far out the point is", () => {
    const far = nearestLandmark(1e9, 1e9);
    expect(far).not.toBeNull();
    expect(far!.meters).toBeGreaterThan(0);
  });
});

describe("poi layer persistence", () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("defaults to fast travel only, so the map doesn't open as marker soup", () => {
    expect(loadPoiLayers()).toEqual(new Set(["fastTravel"]));
  });

  it("round-trips a saved selection", () => {
    savePoiLayers(new Set(["dungeon", "alpha"]));
    expect(loadPoiLayers()).toEqual(new Set(["dungeon", "alpha"]));
  });

  it("round-trips an explicitly empty selection", () => {
    savePoiLayers(new Set());
    expect(loadPoiLayers()).toEqual(new Set());
  });

  it("drops layer names it no longer recognises", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["fastTravel", "atlantis"]));
    expect(loadPoiLayers()).toEqual(new Set(["fastTravel"]));
  });

  it("falls back to the default on unparseable storage", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadPoiLayers()).toEqual(new Set(["fastTravel"]));
  });

  it("survives storage being blocked entirely", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(loadPoiLayers()).toEqual(new Set(["fastTravel"]));

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    // The toggle still works for the session rather than throwing at the user.
    expect(() => savePoiLayers(new Set(["dungeon"]))).not.toThrow();
  });
});
