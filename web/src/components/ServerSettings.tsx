import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";

function formatValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Full settings list, pill-value style per mocks/dashboard.html. Keys stay
 * raw exactly as PalWorldSettings.ini spells them — deliberately not
 * humanized (explicit product decision; don't "fix" this).
 */
export function ServerSettings({ serverId }: { serverId: number }) {
  const settingsQuery = useQuery({
    queryKey: ["server-settings", serverId],
    queryFn: () => api.serverSettings(serverId),
    retry: false,
  });

  if (settingsQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading settings...</p>;
  }
  if (settingsQuery.isError) {
    const err = settingsQuery.error;
    if (err instanceof ApiError && err.status === 400) {
      return (
        <p className="text-sm text-muted-foreground">
          Settings require the REST API — this server is configured RCON-only.
        </p>
      );
    }
    return <p className="text-sm text-destructive">Could not reach server.</p>;
  }

  const entries = Object.entries(settingsQuery.data ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">No settings returned.</p>;
  }

  return (
    <div className="max-h-96 space-y-2.5 overflow-y-auto pr-1">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-center justify-between gap-3">
          <span className="min-w-0 flex-1 break-all font-mono text-xs text-ink/70">{key}</span>
          <span className="shrink-0 whitespace-nowrap rounded-full bg-ink/5 px-2 py-1 font-mono text-xs text-ink/50">
            {formatValue(value)}
          </span>
        </div>
      ))}
    </div>
  );
}
