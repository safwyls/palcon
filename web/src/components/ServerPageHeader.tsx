import type { ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { cn } from "../lib/utils";
import type { Server } from "../lib/api";
import { Badge } from "./ui/badge";

const mobileTabClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
    isActive ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-secondary/50",
  );

export function ServerPageHeader({
  server,
  statusText,
  transport,
  actions,
}: {
  server: Server;
  statusText: string;
  transport?: "rest" | "rcon";
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6">
      <Link to="/" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground lg:hidden">
        <ArrowLeft className="h-4 w-4" />
        Back
      </Link>

      {/* Desktop switches views via the sidebar's Dashboard/Map sub-nav, which
          stays visible alongside the content. On mobile the sidebar is hidden
          while viewing a server, so this tab pair is the only way to switch. */}
      <div className="mb-3 flex gap-1 lg:hidden">
        <NavLink to={`/servers/${server.id}`} end className={mobileTabClass}>
          Dashboard
        </NavLink>
        <NavLink to={`/servers/${server.id}/map`} className={mobileTabClass}>
          Map
        </NavLink>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-foreground">{server.name}</h1>
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            {server.host} &middot; {statusText}
            {transport && (
              <Badge
                variant="outline"
                className={
                  transport === "rest"
                    ? "border-pal-blue/40 bg-pal-blue/15 font-mono text-pal-blue"
                    : "border-brand-amber/40 bg-brand-amber/15 font-mono text-brand-amber"
                }
              >
                {transport.toUpperCase()}
              </Badge>
            )}
          </p>
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
