import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";

function formatValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

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
      return <p className="text-sm text-muted-foreground">Requires the REST API — this server is configured RCON-only.</p>;
    }
    return <p className="text-sm text-destructive">Could not reach server.</p>;
  }

  const entries = Object.entries(settingsQuery.data ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground">No settings returned.</p>;
  }

  return (
    <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-start justify-between gap-3 border-b border-border/50 py-1.5 text-sm">
          <span className="min-w-0 flex-1 break-all font-mono text-xs text-muted-foreground">{key}</span>
          <span className="shrink-0 whitespace-nowrap text-right font-mono text-xs text-foreground">
            {formatValue(value)}
          </span>
        </div>
      ))}
    </div>
  );
}
