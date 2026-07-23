import { MAP_AREAS, MAP_AREA_ORDER, type MapArea } from "../lib/map";
import { cn } from "../lib/utils";

export function MapAreaToggle({ area, onChange }: { area: MapArea; onChange: (area: MapArea) => void }) {
  if (MAP_AREA_ORDER.length <= 1) return null;

  return (
    <div className="inline-flex rounded-md border border-brand-red/30 bg-brand-amber/10 p-0.5">
      {MAP_AREA_ORDER.map((a) => (
        <button
          key={a}
          onClick={() => onChange(a)}
          className={cn(
            "rounded-[5px] px-3 py-1.5 text-sm font-medium transition-colors",
            a === area ? "bg-brand-red text-primary-foreground shadow-sm" : "text-foreground/70 hover:bg-brand-amber/20",
          )}
        >
          {MAP_AREAS[a].label}
        </button>
      ))}
    </div>
  );
}
