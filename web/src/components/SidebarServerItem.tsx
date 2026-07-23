import { useState } from "react";
import { NavLink, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "../lib/utils";
import { api, type Server } from "../lib/api";
import { Button } from "./ui/button";
import { ServerFormDialog } from "./ServerFormDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

const subNavLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    "block rounded-md px-2 py-1 text-sm transition-colors",
    isActive ? "bg-white/10 text-paper font-semibold" : "text-paper/60 hover:bg-white/5 hover:text-paper",
  );

export function SidebarServerItem({ server }: { server: Server }) {
  const { serverID } = useParams<{ serverID?: string }>();
  const isActive = serverID === String(server.id);

  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const infoQuery = useQuery({
    queryKey: ["server-info", server.id],
    queryFn: () => api.serverInfo(server.id),
    retry: false,
    staleTime: 15_000,
  });

  const deleteServer = useMutation({
    mutationFn: () => api.deleteServer(server.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      toast.success(`Removed "${server.name}"`);
      setConfirmOpen(false);
    },
    onError: () => toast.error("Failed to remove server"),
  });

  const statusDot = (
    <span
      className={cn(
        "h-2 w-2 shrink-0 rounded-full",
        infoQuery.isSuccess ? "bg-pal-green" : infoQuery.isError ? "bg-brand-red" : "bg-white/20",
      )}
      title={infoQuery.isSuccess ? "Online" : infoQuery.isError ? "Unreachable" : "Checking..."}
    />
  );

  const editDeleteButtons = (
    <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 text-paper/50 hover:bg-white/10 hover:text-paper"
        title="Edit server"
        onClick={(e) => {
          e.preventDefault();
          setEditOpen(true);
        }}
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 text-paper/50 hover:bg-white/10 hover:text-brand-red"
        title="Remove server"
        onClick={(e) => {
          e.preventDefault();
          setConfirmOpen(true);
        }}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </span>
  );

  return (
    <>
      {isActive ? (
        <div>
          <div className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-semibold text-paper">
            {statusDot}
            <span className="min-w-0 flex-1 truncate">{server.name}</span>
            {editDeleteButtons}
          </div>
          <div className="ml-3.5 space-y-0.5 border-l border-white/10 py-0.5 pl-2.5">
            <NavLink to={`/servers/${server.id}`} end className={subNavLinkClass}>
              Dashboard
            </NavLink>
            <NavLink to={`/servers/${server.id}/map`} className={subNavLinkClass}>
              Map
            </NavLink>
          </div>
        </div>
      ) : (
        <NavLink to={`/servers/${server.id}`} className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-paper/60 transition-colors hover:bg-white/5 hover:text-paper">
          {statusDot}
          <span className="min-w-0 flex-1 truncate">{server.name}</span>
          {editDeleteButtons}
        </NavLink>
      )}

      <ServerFormDialog open={editOpen} onOpenChange={setEditOpen} mode="edit" server={server} />

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove "{server.name}"?</DialogTitle>
            <DialogDescription>
              This only removes it from Palcon — it does not affect the actual game server.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={deleteServer.isPending} onClick={() => deleteServer.mutate()}>
              {deleteServer.isPending ? "Removing..." : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
