import { useEffect, useState } from "react";
import { TransformWrapper, TransformComponent, KeepScale, useControls } from "react-zoom-pan-pinch";
import { ZoomIn, ZoomOut, Maximize, MapPin } from "lucide-react";
import type { Player } from "../lib/api";
import { MAP_AREAS, mapOf, worldToMapPercent, type MapArea } from "../lib/map";
import { cn } from "../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { Button } from "./ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

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

export function PlayerMap({
  players,
  area,
  onAreaChange,
  className,
}: {
  players: Player[];
  area: MapArea;
  onAreaChange: (area: MapArea) => void;
  className?: string;
}) {
  const [candidateIdx, setCandidateIdx] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [settleSignal, setSettleSignal] = useState(0);

  // Each area has its own texture candidates; a resolved/failed index for
  // one area's list doesn't mean anything for another's.
  useEffect(() => setCandidateIdx(0), [area]);

  const textureCandidates = MAP_AREAS[area].textureCandidates;
  const hasBackground = candidateIdx < textureCandidates.length;

  const playersHere = players.filter((p) => mapOf(p.location_x, p.location_y) === area);

  function selectPlayer(p: Player) {
    setSelectedId(p.playerId);
    const playerArea = mapOf(p.location_x, p.location_y);
    if (playerArea !== area) onAreaChange(playerArea);
    setFocusId(p.playerId);
  }

  return (
    <div className="flex h-full flex-col gap-3 lg:flex-row">
      <div className="order-2 max-h-48 shrink-0 overflow-y-auto rounded-lg border border-border bg-card shadow-sm lg:order-1 lg:h-auto lg:w-[36rem] lg:max-h-none">
        {players.length > 0 ? (
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="px-2">Name</TableHead>
                <TableHead className="w-12 px-2">Lvl</TableHead>
                <TableHead className="w-16 px-2 text-right">Ping</TableHead>
                <TableHead className="w-36 px-2 text-right">Coords</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {players.map((p) => {
                const playerArea = mapOf(p.location_x, p.location_y);
                return (
                  <TableRow
                    key={p.playerId}
                    onClick={() => selectPlayer(p)}
                    className={cn(
                      "cursor-pointer",
                      selectedId === p.playerId ? "bg-secondary" : "hover:bg-secondary/50",
                    )}
                  >
                    <TableCell className="px-2 py-1.5 font-medium text-foreground">
                      <div className="flex items-center gap-1.5">
                        <span className="min-w-0 truncate" title={p.name}>{p.name}</span>
                        {playerArea !== area && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <MapPin className="h-3 w-3 shrink-0 text-muted-foreground/70" />
                            </TooltipTrigger>
                            <TooltipContent>On {MAP_AREAS[playerArea].label}</TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="px-2 py-1.5">{p.level}</TableCell>
                    <TableCell className="px-2 py-1.5 text-right">{Math.round(p.ping)}ms</TableCell>
                    <TableCell className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-xs text-muted-foreground">
                      {Math.round(p.location_x)}, {Math.round(p.location_y)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <p className="px-2 py-1.5 text-sm text-muted-foreground">No players online.</p>
        )}
      </div>

      <div className="order-1 min-w-0 flex-1 rounded-lg border border-border bg-card p-3 shadow-sm lg:order-2">
        <div
          className={cn(
            "relative aspect-square w-full h-full overflow-hidden rounded-md bg-muted/20",
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
                <FocusOnPlayer focusId={focusId} settleSignal={settleSignal} onDone={() => setFocusId(null)} />

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
                        onLoad={() => setSettleSignal((t) => t + 1)}
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
                                onClick={() => selectPlayer(p)}
                                className={cn(
                                  "h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-background shadow",
                                  selectedId === p.playerId ? "bg-brand-red" : "bg-pal-green",
                                )}
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
      </div>
    </div>
  );
}
