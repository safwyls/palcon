import { useState } from "react";

export function ActionsPanel({
  onBroadcast,
  onSave,
  onShutdown,
}: {
  onBroadcast: (message: string) => void;
  onSave: () => void;
  onShutdown: (waitSeconds: number, message: string) => void;
}) {
  const [broadcastMsg, setBroadcastMsg] = useState("");
  const [shutdownMsg, setShutdownMsg] = useState("Server restarting soon");
  const [shutdownWait, setShutdownWait] = useState(60);

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <input
          className="flex-1 rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
          placeholder="Broadcast message"
          value={broadcastMsg}
          onChange={(e) => setBroadcastMsg(e.target.value)}
        />
        <button
          onClick={() => broadcastMsg && onBroadcast(broadcastMsg)}
          className="rounded bg-indigo-600 px-3 py-2 text-sm hover:bg-indigo-500"
        >
          Broadcast
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button onClick={onSave} className="rounded bg-slate-700 px-3 py-2 text-sm hover:bg-slate-600">
          Save world
        </button>
      </div>

      <div className="rounded border border-red-900/50 bg-red-950/20 p-3 space-y-2">
        <p className="text-sm font-medium text-red-300">Shutdown server</p>
        <div className="flex gap-2">
          <input
            type="number"
            className="w-24 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm"
            value={shutdownWait}
            onChange={(e) => setShutdownWait(Number(e.target.value))}
          />
          <input
            className="flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm"
            value={shutdownMsg}
            onChange={(e) => setShutdownMsg(e.target.value)}
          />
          <button
            onClick={() => onShutdown(shutdownWait, shutdownMsg)}
            className="rounded bg-red-800 px-3 py-1 text-sm hover:bg-red-700"
          >
            Shutdown
          </button>
        </div>
      </div>
    </div>
  );
}
