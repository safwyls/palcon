import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, type Server } from "../lib/api";

export function ServerCard({ server }: { server: Server }) {
  const infoQuery = useQuery({
    queryKey: ["server-info", server.id],
    queryFn: () => api.serverInfo(server.id),
    retry: false,
    staleTime: 15_000,
  });

  return (
    <Link
      to={`/servers/${server.id}`}
      className="block rounded-lg border border-slate-800 bg-slate-900 p-4 transition hover:border-slate-600"
    >
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">{server.name}</h2>
        <span
          className={`h-2.5 w-2.5 rounded-full ${infoQuery.isSuccess ? "bg-emerald-500" : infoQuery.isError ? "bg-red-500" : "bg-slate-600"}`}
          title={infoQuery.isSuccess ? "Online" : infoQuery.isError ? "Unreachable" : "Checking..."}
        />
      </div>
      <p className="text-sm text-slate-400">
        {server.host}:{server.useRest ? server.restPort : server.rconPort}
      </p>
      {infoQuery.data && <p className="mt-2 text-sm text-slate-300">{infoQuery.data.servername}</p>}
    </Link>
  );
}
