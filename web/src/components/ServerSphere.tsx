import { useQuery } from "@tanstack/react-query";
import { api, type Server } from "../lib/api";
import { serverColor, initials } from "../lib/palette";
import { cn } from "../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/**
 * Pal Sphere server button: conic split ring in the server's assigned color,
 * initials in the middle, connectivity dot on the rim. Shared between the
 * desktop rail and the mobile bottom bar.
 */
export function ServerSphere({
  server,
  active,
  size = "md",
  onClick,
}: {
  server: Server;
  active: boolean;
  size?: "md" | "sm";
  onClick: () => void;
}) {
  const infoQuery = useQuery({
    queryKey: ["server-info", server.id],
    queryFn: () => api.serverInfo(server.id),
    retry: false,
    staleTime: 15_000,
  });

  const dotColor = infoQuery.isSuccess ? "bg-pal-green" : infoQuery.isError ? "bg-ink-soft" : "bg-white/20";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          className={cn(
            "sphere-ring relative shrink-0 rounded-full transition-opacity",
            size === "md" ? "h-11 w-11 p-[3px]" : "h-10 w-10 p-[2px]",
            active ? "opacity-100" : "opacity-60 hover:opacity-100",
          )}
          style={{ "--ring-color": serverColor(server.id) } as React.CSSProperties}
        >
          <span className="flex h-full w-full items-center justify-center rounded-full bg-ink-light font-display text-sm font-bold text-paper">
            {initials(server.name)}
          </span>
          <span className={cn("absolute -bottom-1 -right-1 h-3.5 w-3.5 rounded-full border-2 border-ink", dotColor)} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{server.name}</TooltipContent>
    </Tooltip>
  );
}
