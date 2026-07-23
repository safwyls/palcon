import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api, type Server } from "../lib/api";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

export function DeleteServerDialog({
  server,
  open,
  onOpenChange,
}: {
  server: Server;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const deleteServer = useMutation({
    mutationFn: () => api.deleteServer(server.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      toast.success(`Removed "${server.name}"`);
      onOpenChange(false);
      navigate("/");
    },
    onError: () => toast.error("Failed to remove server"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove "{server.name}"?</DialogTitle>
          <DialogDescription>
            This only removes it from Palcon — it does not affect the actual game server.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={deleteServer.isPending} onClick={() => deleteServer.mutate()}>
            {deleteServer.isPending ? "Removing..." : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
