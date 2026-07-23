import { useEffect, useState } from "react";
import { TransformWrapper, TransformComponent, KeepScale } from "react-zoom-pan-pinch";
import { ZoomIn, ZoomOut, Maximize } from "lucide-react";
import type { Player } from "../lib/api";
import { MAP_AREAS, MAP_AREA_ORDER, DEFAULT_MAP_AREA, mapOf, worldToMapPercent, type MapArea } from "../lib/map";
import { cn } from "../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { Button } from "./ui/button";

export function PlayerMap({ players, className }: { players: Player[]; className?: string }) {
  const [area, setArea] = useState<MapArea>(DEFAULT_MAP_AREA);
  const [candidateIdx, setCandidateIdx] = useState(0);

  // Each area has its own texture candidates; a resolved/failed index for
  // one area's list doesn't mean anything for another's.
  useEffect(() => setCandidateIdx(0), [area]);

  const textureCandidates = MAP_AREAS[area].textureCandidates;
  const hasBackground = candidateIdx < textureCandidates.length;

  const playersHere = players.filter((p) => mapOf(p.location_x, p.location_y) === area);
  const elsewhereCount = players.length - playersHere.length;

  return (
    <div className="flex h-full flex-col gap-2">
      {MAP_AREA_ORDER.length > 1 && (
        <div className="flex items-center gap-1">
          {MAP_AREA_ORDER.map((a) => (
            <Button
              key={a}
              variant={a === area ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setArea(a)}
            >
              {MAP_AREAS[a].label}
            </Button>
          ))}
          {elsewhereCount > 0 && (
            <span className="text-xs text-muted-foreground">
              {elsewhereCount} player{elsewhereCount === 1 ? "" : "s"} on the other map
            </span>
          )}
        </div>
      )}

      <div
        className={cn(
          "relative aspect-square w-full flex-1 min-h-0 overflow-hidden rounded-md border border-border bg-muted/20",
          className,
        )}
      >
        <TransformWrapper
          key={area}
          minScale={1}
          maxScale={12}
          initialScale={1}
          centerOnInit
          doubleClick={{ mode: "zoomIn" }}
          panning={{ velocityDisabled: true }}
        >
          {({ zoomIn, zoomOut, resetTransform }) => (
            <>
              <div className="absolute right-2 top-2 z-10 flex flex-col gap-1">
                <Button variant="secondary" size="icon" className="h-7 w-7" title="Zoom in" onClick={() => zoomIn()}>
                  <ZoomIn className="h-4 w-4" />
                </Button>
                <Button variant="secondary" size="icon" className="h-7 w-7" title="Zoom out" onClick={() => zoomOut()}>
                  <ZoomOut className="h-4 w-4" />
                </Button>
                <Button
                  variant="secondary"
                  size="icon"
                  className="h-7 w-7"
                  title="Reset view"
                  onClick={() => resetTransform()}
                >
                  <Maximize className="h-4 w-4" />
                </Button>
              </div>

              <TransformComponent wrapperClass="!w-full !h-full" contentClass="!w-full !h-full">
                <div
                  className="relative h-full w-full"
                  style={
                    !hasBackground
                      ? {
                          backgroundImage:
                            "linear-gradient(hsl(var(--border)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--border)) 1px, transparent 1px)",
                          backgroundSize: "5% 5%",
                        }
                      : undefined
                  }
                >
                  {hasBackground && (
                    <img
                      src={textureCandidates[candidateIdx]}
                      alt={`Palworld map — ${MAP_AREAS[area].label}`}
                      className="absolute inset-0 h-full w-full object-cover"
                      onError={() => setCandidateIdx((i) => i + 1)}
                      draggable={false}
                    />
                  )}

                  {playersHere.map((p) => {
                    const { xPct, yPct } = worldToMapPercent(p.location_x, p.location_y, area);
                    return (
                      // KeepScale counteracts the map's zoom so the marker itself
                      // stays a constant pixel size at any zoom level — same
                      // convention as Leaflet/Mapbox/Google Maps pins. Position
                      // (left/top) goes on KeepScale; centering the dot on that
                      // point is a separate transform on the child, since
                      // KeepScale needs its own transform for the counter-scale.
                      //
                      // transformOrigin must be "0 0": KeepScale's counter-scale
                      // is a plain `scale()` with no transform-origin of its own,
                      // so it defaults to the browser's center-of-element origin.
                      // That's a mismatch with left/top anchoring the marker by
                      // its top-left corner — scaling around the center instead
                      // drags the marker away from its true position by an
                      // amount that grows with zoom (invisible at 1:1, since
                      // scale(1) is a no-op regardless of origin). Anchoring the
                      // origin to the same top-left point removes the drift.
                      <KeepScale
                        key={p.playerId}
                        className="absolute"
                        style={{
                          left: `${Math.min(100, Math.max(0, xPct))}%`,
                          top: `${Math.min(100, Math.max(0, yPct))}%`,
                          transformOrigin: "0 0",
                        }}
                      >
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <div className="h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-background bg-pal-green shadow" />
                          </TooltipTrigger>
                          <TooltipContent>{p.name}</TooltipContent>
                        </Tooltip>
                      </KeepScale>
                    );
                  })}
                </div>
              </TransformComponent>
            </>
          )}
        </TransformWrapper>

        {!hasBackground && (
          <p className="pointer-events-none absolute bottom-2 left-2 z-10 text-xs text-muted-foreground">
            No map image found — see web/public/README.md
          </p>
        )}

        {hasBackground && playersHere.length === 0 && players.length > 0 && (
          <p className="pointer-events-none absolute bottom-2 left-2 z-10 rounded bg-background/80 px-2 py-1 text-xs text-muted-foreground">
            No players on this map right now.
          </p>
        )}
      </div>
    </div>
  );
}
