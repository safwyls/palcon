import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, ServerCog, LogOut } from "lucide-react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { SidebarServerItem } from "./SidebarServerItem";
import { ServerFormDialog } from "./ServerFormDialog";
import { Button } from "./ui/button";

export function AppSidebar() {
  const { username, logout } = useAuth();
  const serversQuery = useQuery({ queryKey: ["servers"], queryFn: api.listServers });
  const [addOpen, setAddOpen] = useState(false);

  return (
    <div className="flex h-full flex-col bg-ink text-paper">
      <div className="flex items-center gap-2 border-b border-white/10 p-4">
        <ServerCog className="h-5 w-5 text-brand-amber" />
        <h1 className="font-display text-lg font-bold tracking-wide">Palcon</h1>
      </div>

      <div className="p-3">
        <Button size="sm" className="clip-notch w-full" onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4" />
          Add server
        </Button>
        <ServerFormDialog open={addOpen} onOpenChange={setAddOpen} mode="create" />
      </div>

      <nav className="mt-1 flex-1 space-y-0.5 overflow-y-auto px-2">
        {serversQuery.isLoading && <p className="px-2 py-1.5 text-sm text-paper/50">Loading...</p>}
        {serversQuery.isError && <p className="px-2 py-1.5 text-sm text-brand-red">Failed to load servers.</p>}
        {serversQuery.data?.map((server) => (
          <SidebarServerItem key={server.id} server={server} />
        ))}
        {serversQuery.data?.length === 0 && (
          <p className="px-2 py-1.5 text-sm text-paper/40">No servers yet. Add one above.</p>
        )}
      </nav>

      <div className="flex items-center justify-between border-t border-white/10 p-3 text-sm text-paper/50">
        <span className="truncate font-mono text-xs">{username}</span>
        <Button variant="ghost" size="sm" className="text-paper/60 hover:bg-white/10 hover:text-paper" onClick={() => logout()}>
          <LogOut className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
