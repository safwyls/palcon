// Palworld world-to-map coordinate conversion.
//
// Bounds/formula verified against two community projects: palworld-save-pal
// (github.com/oMaN-Rod/palworld-save-pal), which calibrates against the
// game's actual DT_WorldMapUIData, and palworld-server-manager
// (github.com/amantu-qbit/palworld-server-manager)'s lib/mapProject.ts,
// which documents a detail the first source's raw formula omits (see below).

export type MapArea = "MainMap" | "Tree";

interface AreaBounds {
  min: { x: number; y: number };
  max: { x: number; y: number };
  /** Candidate background image paths, tried in order — see web/public/README.md. */
  textureCandidates: string[];
  label: string;
}

// Tree is listed first because it carries the game's WorldMapPriority 1:
// where the two areas' bounding boxes overlap, Tree wins. `mapOf` relies on
// this object's key order for that priority — keep Tree first.
export const MAP_AREAS: Record<MapArea, AreaBounds> = {
  Tree: {
    min: { x: 347351.5, y: -818197.0 },
    max: { x: 689148.5, y: -476400.0 },
    textureCandidates: ["/palworld-treemap.webp", "/palworld-treemap.png", "/palworld-treemap.jpg"],
    label: "Tree",
  },
  MainMap: {
    min: { x: -1099400, y: -724400 },
    max: { x: 349400, y: 724400 },
    textureCandidates: ["/palworld-map.webp", "/palworld-map.png", "/palworld-map.jpg"],
    label: "Main map",
  },
};

/** Left-to-right order for a UI area switcher (main map first) — a separate
 * concern from the priority order `MAP_AREAS` itself is keyed in. */
export const MAP_AREA_ORDER: MapArea[] = ["MainMap", "Tree"];
export const DEFAULT_MAP_AREA: MapArea = "MainMap";

// The map textures are full 8192x8192 stitched world images — decoding one
// is real, unavoidable CPU/GPU work (hundreds of ms), paid once per image
// per session. If that decode is still in flight when the user's first
// pan/zoom gesture lands (which it usually is, if it only starts once they
// open the Map tab), the gesture visibly stutters right as the decode
// finishes mid-drag. Kicking the fetch+decode off as early as the app shell
// mounts — instead of only once PlayerMap itself renders the <img> — gives
// it a head start so it's normally done well before the user gets there.
export function preloadMapTextures() {
  for (const area of Object.keys(MAP_AREAS) as MapArea[]) {
    const img = new Image();
    img.src = MAP_AREAS[area].textureCandidates[0];
    img.decode?.().catch(() => {});
  }
}

/** Native size of each square map texture, in pixels. */
const MAP_SIZE = 8192;

function cmPerPx(area: MapArea): number {
  const { min, max } = MAP_AREAS[area];
  return (max.x - min.x) / MAP_SIZE;
}

/**
 * Which map area a world position belongs to, in priority order (Tree
 * first). Falls back to MainMap for a point outside both areas' bounds,
 * rather than returning null — a stray coordinate should still land
 * somewhere visible (clamped to that area's edge) instead of vanishing.
 */
export function mapOf(worldX: number, worldY: number): MapArea {
  for (const area of Object.keys(MAP_AREAS) as MapArea[]) {
    const { min, max } = MAP_AREAS[area];
    if (worldX >= min.x && worldX <= max.x && worldY >= min.y && worldY <= max.y) {
      return area;
    }
  }
  return DEFAULT_MAP_AREA;
}

/**
 * Converts raw world coordinates (Player.location_x/location_y from the
 * REST API) into a 0-100 percentage pair suitable for CSS `left`/`top`
 * positioning over a square map container for the given area.
 *
 * Two things trip this up:
 * - Axis swap: the map's horizontal axis is world +Y, its vertical axis is
 *   world X — the game's map is rotated relative to world space.
 * - Y is y-up (0 = bottom) in the raw formula (it's meant for OpenLayers,
 *   which is y-up natively), but CSS `top` is y-down (0% = top). Skipping
 *   the flip below mirrors every player north-south — which looks like
 *   "roughly plausible but wrong" positions, not an obvious crash, so it's
 *   an easy one to miss without a real server to test against.
 */
export function worldToMapPercent(worldX: number, worldY: number, area: MapArea): { xPct: number; yPct: number } {
  const { min } = MAP_AREAS[area];
  const cm = cmPerPx(area);
  const pixelX = (worldY - min.y) / cm;
  const pixelYUp = (worldX - min.x) / cm;
  return {
    xPct: (pixelX / MAP_SIZE) * 100,
    yPct: (1 - pixelYUp / MAP_SIZE) * 100,
  };
}
