import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ServerWriteInput } from "../lib/api";
import { ServerCard } from "../components/ServerCard";
import { useAuth } from "../lib/auth";

const emptyForm: ServerWriteInput = {
  name: "",
  host: "",
  rconPort: 25575,
  rconPassword: "",
  restPort: 8212,
  restPassword: "",
  useRest: true,
  enabled: true,
};

export function Dashboard() {
  const { username, logout } = useAuth();
  const queryClient = useQueryClient();
  const serversQuery = useQuery({ queryKey: ["servers"], queryFn: api.listServers });
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<ServerWriteInput>(emptyForm);

  const createServer = useMutation({
    mutationFn: (input: ServerWriteInput) => api.createServer(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      setForm(emptyForm);
      setShowForm(false);
    },
  });

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Palcon</h1>
        <div className="flex items-center gap-3 text-sm text-slate-400">
          <span>{username}</span>
          <button onClick={() => logout()} className="rounded bg-slate-800 px-3 py-1 hover:bg-slate-700">
            Sign out
          </button>
        </div>
      </div>

      <div className="mb-4 flex justify-end">
        <button onClick={() => setShowForm((v) => !v)} className="rounded bg-indigo-600 px-3 py-2 text-sm hover:bg-indigo-500">
          {showForm ? "Cancel" : "Add server"}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            createServer.mutate(form);
          }}
          className="mb-6 space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-4"
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
            <Field label="Host" value={form.host} onChange={(v) => setForm({ ...form, host: v })} />
            <Field
              label="REST port"
              value={String(form.restPort)}
              onChange={(v) => setForm({ ...form, restPort: Number(v) })}
            />
            <Field
              label="REST password"
              value={form.restPassword ?? ""}
              onChange={(v) => setForm({ ...form, restPassword: v })}
              type="password"
            />
            <Field
              label="RCON port"
              value={String(form.rconPort)}
              onChange={(v) => setForm({ ...form, rconPort: Number(v) })}
            />
            <Field
              label="RCON password"
              value={form.rconPassword ?? ""}
              onChange={(v) => setForm({ ...form, rconPassword: v })}
              type="password"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" checked={form.useRest} onChange={(e) => setForm({ ...form, useRest: e.target.checked })} />
            Prefer REST API (falls back to RCON)
          </label>
          {createServer.isError && <p className="text-sm text-red-400">{(createServer.error as Error).message}</p>}
          <button type="submit" className="rounded bg-emerald-700 px-3 py-2 text-sm hover:bg-emerald-600">
            Save server
          </button>
        </form>
      )}

      {serversQuery.isLoading && <p className="text-slate-400">Loading...</p>}
      {serversQuery.isError && <p className="text-red-400">Failed to load servers.</p>}

      <div className="space-y-3">
        {serversQuery.data?.map((server) => (
          <ServerCard key={server.id} server={server} />
        ))}
        {serversQuery.data?.length === 0 && <p className="text-slate-500">No servers yet. Add one above.</p>}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-xs text-slate-400">{label}</label>
      <input
        type={type}
        className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
