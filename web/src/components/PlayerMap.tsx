import { useEffect, useRef, useState } from "react";
import {
  TransformWrapper,
  TransformComponent,
  KeepScale,
  useControls,
  useTransformContext,
  useTransformInit,
} from "react-zoom-pan-pinch";
import { Home, ZoomIn, ZoomOut, Maximize } from "lucide-react";
import type { Player } from "../lib/api";
import { MAP_AREAS, mapOf, worldToMapPercent, type MapArea } from "../lib/map";
import { playerColor } from "../lib/palette";
import { cn } from "../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { Button } from "./ui/button";

function markerId(playerId: string) {
  return `player-marker-${playerId}`;
}

/** DOM id for a save-derived marker, so it can be zoomed to like a player. */
export function mapMarkerId(id: string) {
  return `map-marker-${id}`;
}

const MAX_SCALE = 12;

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
  /** DOM id of the marker to zoom to — a player pin or a base marker. */
  focusId: string | null;
  settleSignal: number;
  onDone: () => void;
}) {
  const { zoomToElement } = useControls();

  useEffect(() => {
    if (!focusId) return;
    const raf = requestAnimationFrame(() => zoomToElement(focusId, 4, 500));
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

// The library's centerOnInit measures the wrapper exactly once, via a
// one-shot ResizeObserver that disconnects after its first layout change —
// so if the surrounding layout settles later (nav panels mounting, fonts,
// a window resize), the content is left centered against a stale wrapper
// size until the next gesture snaps it. This keeps a persistent observer
// and re-centers while at fit zoom; when zoomed in, a recenter would yank
// the view around, so the library's own bounds clamping on the next
// gesture is left to handle it.
function KeepCenteredOnResize() {
  const context = useTransformContext();
  const { centerView } = useControls();

  // useTransformInit (not a plain effect): wrapperComponent is only
  // assigned once the library finishes initializing, which is after this
  // component's own mount effect would have run and found null.
  useTransformInit(() => {
    const wrapper = context.wrapperComponent;
    if (!wrapper) return;
    const ro = new ResizeObserver(() => {
      if (context.state.scale <= 1.001) centerView(1, 0);
    });
    ro.observe(wrapper);
    return () => ro.disconnect();
  });

  return null;
}

// Backing resolution of the texture canvas. The source images are 8192x8192,
// but rendered via <img> Chromium re-decodes the full webp (~300-450ms,
// blocking) every time the zoom crosses into a draw scale whose downscaled
// bitmap isn't in its decoded-image cache — and the full-res entry is too
// big (268MB raw) to stay cached reliably, so the stall can recur at any
// time ("sometimes laggy"). Decoding ONCE off-main-thread via
// createImageBitmap into a fixed-size canvas removes decoding from the
// zoom path entirely: canvases never re-decode, so every zoom/pan is pure
// GPU compositing. 4096² (67MB) trades a little sharpness at extreme zoom
// (>4.8x on a ~850px viewport) for deterministic smoothness.
const TEXTURE_SIZE = 4096;

/**
 * The zoomable map: texture, pins, zoom controls. Selection state lives in
 * the page (ServerMap) so the HUD and player list stay in sync with it;
 * this component only reports clicks up via onSelect.
 *
 * The component root — the zoom viewport — fills whatever region it's given
 * at any aspect ratio. Only the CONTENT inside the transform must stay
 * square: player positions are percentages of the square 8192x8192 texture,
 * so a non-square content box would crop the image asymmetrically while the
 * percentage math stayed naive to it, drifting every pin. The content square
 * is sized min(100cqw,100cqh) against the root (container-type: size) —
 * beware "aspect-square h-full max-w-full" here: an explicit h-full stops
 * aspect-ratio from shrinking the height once max-w-full caps the width,
 * which silently produced a non-square box in portrait regions.
 */
export interface MapMarker {
  id: string;
  label: string;
  sublabel?: string;
  x: number;
  y: number;
  kind: "base" | "offline";
}

export function PlayerMap({
  players,
  markers = [],
  area,
  selectedId,
  focusId,
  onSelect,
  onFocusDone,
  className,
}: {
  players: Player[];
  /** Save-derived overlays: guild bases and where offline players logged
   * off. Drawn beneath live players, which are the reason for the view. */
  markers?: MapMarker[];
  area: MapArea;
  selectedId: string | null;
  focusId: string | null;
  onSelect: (player: Player) => void;
  onFocusDone: () => void;
  className?: string;
}) {
  const [texState, setTexState] = useState<"loading" | "ready" | "missing">("loading");
  const [settleSignal, setSettleSignal] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Decode the area's texture once (off the main thread) into the canvas,
  // trying each candidate path in order. The canvas remounts per area along
  // with the TransformWrapper (key={area}), so this re-runs against the
  // fresh element.
  useEffect(() => {
    let cancelled = false;
    setTexState("loading");
    (async () => {
      for (const url of MAP_AREAS[area].textureCandidates) {
        try {
          const res = await fetch(url);
          if (!res.ok) continue;
          const blob = await res.blob();
          const bitmap = await createImageBitmap(blob, {
            resizeWidth: TEXTURE_SIZE,
            resizeHeight: TEXTURE_SIZE,
            resizeQuality: "high",
          });
          if (cancelled) {
            bitmap.close();
            return;
          }
          const ctx = canvasRef.current?.getContext("2d");
          if (!ctx) return;
          ctx.drawImage(bitmap, 0, 0);
          bitmap.close();
          setTexState("ready");
          setSettleSignal((t) => t + 1);
          return;
        } catch {
          // decode/network failure — try the next candidate
        }
      }
      if (!cancelled) setTexState("missing");
    })();
    return () => {
      cancelled = true;
    };
  }, [area]);

  const hasBackground = texState !== "missing";

  const playersHere = players.filter((p) => mapOf(p.location_x, p.location_y) === area);

  return (
    <div className={cn("relative h-full w-full overflow-hidden [container-type:size]", className)}>
      <TransformWrapper
        key={area}
        minScale={1}
        maxScale={MAX_SCALE}
        initialScale={1}
        centerOnInit
        // Whenever the square content is smaller than the viewport in an
        // axis (e.g. horizontally at 1x on a wide screen), pin it centered
        // in that axis instead of letting it be dragged around the empty
        // space; panning behaves normally once zoomed past the fit size.
        centerZoomedOut
        doubleClick={{ mode: "zoomIn" }}
        panning={{ velocityDisabled: true }}
      >
        {({ zoomIn, zoomOut, resetTransform }) => (
          <>
            <FocusOnPlayer focusId={focusId} settleSignal={settleSignal} onDone={onFocusDone} />
            <KeepCenteredOnResize />

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

            <TransformComponent wrapperClass="!w-full !h-full">
              {/* The CONTENT square: pins are percentage-positioned against
                  this box, so it must stay square — but the zoom viewport
                  around it fills the whole region at any aspect ratio, so
                  zooming in uses every pixel of a wide (or tall) screen
                  instead of staying letterboxed to the square. Sized by
                  container query against the component root. */}
              <div
                className="relative h-[min(100cqw,100cqh)] w-[min(100cqw,100cqh)]"
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
                <canvas
                  ref={canvasRef}
                  width={TEXTURE_SIZE}
                  height={TEXTURE_SIZE}
                  role="img"
                  aria-label={`Palworld map — ${MAP_AREAS[area].label}`}
                  className="absolute inset-0 h-full w-full"
                />

                {markers
                  .filter((m) => mapOf(m.x, m.y) === area)
                  .map((m) => {
                    const { xPct, yPct } = worldToMapPercent(m.x, m.y, area);
                    return (
                      <KeepScale
                        key={m.id}
                        id={mapMarkerId(m.id)}
                        className="absolute flex"
                        style={{
                          left: `${Math.min(100, Math.max(0, xPct))}%`,
                          top: `${Math.min(100, Math.max(0, yPct))}%`,
                          transformOrigin: "0 0",
                        }}
                      >
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              className={cn(
                                "flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-[3px] border shadow",
                                m.kind === "base"
                                  ? "border-paper bg-brand-amber"
                                  : "border-paper/70 bg-ink/60",
                              )}
                            >
                              {m.kind === "base" ? (
                                <Home className="h-2.5 w-2.5 text-ink" />
                              ) : (
                                <span className="h-1.5 w-1.5 rounded-full bg-paper/80" />
                              )}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            {m.label}
                            {m.sublabel && <span className="block text-xs opacity-70">{m.sublabel}</span>}
                          </TooltipContent>
                        </Tooltip>
                      </KeepScale>
                    );
                  })}

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
                    // "flex" so the wrapper hugs the button exactly — as a
                    // block, the inline button gets a line box (taller than
                    // the button) and baseline alignment shifts the marker
                    // down a few px from its true anchor.
                    <KeepScale
                      key={p.playerId}
                      id={markerId(p.playerId)}
                      className="absolute flex"
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
