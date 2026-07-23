import { useEffect, useState } from "react";
import { TransformWrapper, TransformComponent, KeepScale, useControls } from "react-zoom-pan-pinch";
import { ZoomIn, ZoomOut, Maximize } from "lucide-react";
import type { Player } from "../lib/api";
import { MAP_AREAS, mapOf, worldToMapPercent, type MapArea } from "../lib/map";
import { playerColor } from "../lib/palette";
import { cn } from "../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { Button } from "./ui/button";

function markerId(playerId: string) {
  return `player-marker-${playerId}`;
}

// Rendered inside <TransformWrapper> so useControls() can reach its pan/zoom
// context. Watches for a pending "go to this player" request and animates
// there once the target marker actually exists in the DOM — which, after an
// area switch, is only true once the *new* TransformWrapper (it remounts via
// `key={area}`) has mounted.
//
// On a fresh mount the library sets up its own post-init ResizeObserver
// (for `centerOnInit`) that re-centers the view on the first layout change
// it sees and then disconnects — which, if the background image finishes
// loading shortly after our zoomToElement call, fires *after* us and
// silently undoes it. `settleSignal` (bumped by the image's onLoad) makes
// this effect re-fire once that's happened, so our call is the one that
// actually sticks regardless of which one lands first.
function FocusOnPlayer({
  focusId,
  settleSignal,
  onDone,
}: {
  focusId: string | null;
  settleSignal: number;
  onDone: () => void;
}) {
  const { zoomToElement } = useControls();

  useEffect(() => {
    if (!focusId) return;
    const raf = requestAnimationFrame(() => zoomToElement(markerId(focusId), 4, 500));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, settleSignal]);

  useEffect(() => {
    if (!focusId) return;
    // Keep focusId "live" past the animation so a late settleSignal change
    // (image load) still triggers the re-fire above, then clear it — long
    // enough to cover a slow-ish image load, short enough that re-clicking
    // the same player again later still registers as a fresh request.
    const t = setTimeout(onDone, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId]);

  return null;
}

/**
 * The square zoomable map canvas: texture, pins, zoom controls. Selection
 * state lives in the page (ServerMap) so the HUD and player list stay in
 * sync with it; this component only reports clicks up via onSelect.
 *
 * Must stay square: player positions are percentages of the 8192x8192
 * texture, so a non-square box would crop the image asymmetrically while
 * the percentage math stayed naive to it, drifting every pin.
 */
export function PlayerMap({
  players,
  area,
  selectedId,
  focusId,
  onSelect,
  onFocusDone,
  className,
}: {
  players: Player[];
  area: MapArea;
  selectedId: string | null;
  focusId: string | null;
  onSelect: (player: Player) => void;
  onFocusDone: () => void;
  className?: string;
}) {
  const [candidateIdx, setCandidateIdx] = useState(0);
  const [settleSignal, setSettleSignal] = useState(0);

  // Each area has its own texture candidates; a resolved/failed index for
  // one area's list doesn't mean anything for another's.
  useEffect(() => setCandidateIdx(0), [area]);

  const textureCandidates = MAP_AREAS[area].textureCandidates;
  const hasBackground = candidateIdx < textureCandidates.length;

  const playersHere = players.filter((p) => mapOf(p.location_x, p.location_y) === area);

  return (
    <div className={cn("relative aspect-square h-full max-w-full overflow-hidden", className)}>
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
            <FocusOnPlayer focusId={focusId} settleSignal={settleSignal} onDone={onFocusDone} />

            <div className="absolute bottom-2 right-2 z-10 flex flex-col gap-1">
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
                    onLoad={() => setSettleSignal((t) => t + 1)}
                    draggable={false}
                  />
                )}

                {playersHere.map((p) => {
                  const { xPct, yPct } = worldToMapPercent(p.location_x, p.location_y, area);
                  const selected = selectedId === p.playerId;
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
                      id={markerId(p.playerId)}
                      className="absolute"
                      style={{
                        left: `${Math.min(100, Math.max(0, xPct))}%`,
                        top: `${Math.min(100, Math.max(0, yPct))}%`,
                        transformOrigin: "0 0",
                      }}
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => onSelect(p)}
                            className={cn(
                              "h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-paper shadow transition-transform",
                              selected && "scale-[1.35]",
                            )}
                            style={{
                              backgroundColor: playerColor(p.playerId),
                              boxShadow: selected ? "0 0 0 4px rgba(232,73,29,0.35)" : undefined,
                            }}
                          />
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
  );
}
