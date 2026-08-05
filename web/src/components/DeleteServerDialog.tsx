import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";

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
  const [destroy, setDestroy] = useState(false);

  // Only the provisioner can destroy a container, and only one it created
  // — so the option appears only when both halves are present. Asked for
  // when the dialog opens rather than on mount, since most sessions never
  // open it.
  const { data: provisioner, isError: provisionerUnreachable } = useQuery({
    queryKey: ["provision-defaults"],
    queryFn: api.provisionDefaults,
    enabled: open,
    staleTime: 60_000,
  });
  const canDestroy = Boolean(provisioner?.available && server.containerName);
  // Hiding the option on a failed lookup would leave an admin who opened
  // this dialog *to* destroy the container quietly deleting the row and
  // orphaning it. Say why it's missing instead.
  const askedButUnreachable = provisionerUnreachable && Boolean(server.containerName);

  // A dialog reopened after a cancel must not still be armed.
  useEffect(() => {
    if (!open) setDestroy(false);
  }, [open]);

  const deleteServer = useMutation({
    mutationFn: () => api.deleteServer(server.id, destroy && canDestroy),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      toast.success(
        result?.destroyed
          ? `Removed "${server.name}" and destroyed ${result.destroyed}`
          : `Removed "${server.name}"`,
        result?.dataDir ? { description: `World data kept at ${result.dataDir}` } : undefined,
      );
      onOpenChange(false);
      navigate("/");
    },
    onError: (error: Error) => toast.error(error.message || "Failed to remove server"),
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

        {askedButUnreachable && (
          <p className="rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">
            Couldn't reach the provisioner, so destroying{" "}
            <span className="font-mono text-xs">{server.containerName}</span> isn't available right now. Removing
            this server will leave the container running.
          </p>
        )}

        {canDestroy && (
          <div className="space-y-3 rounded-lg bg-muted/60 p-4">
            <div className="flex items-start gap-3">
              {/* The switch defaults to --primary when checked, which this
                  app spends on routine actions; armed, it should read in
                  the same deeper red as the button it changes. */}
              <Switch
                id="destroy-container"
                checked={destroy}
                onCheckedChange={setDestroy}
                className="mt-0.5 shrink-0 data-[state=checked]:bg-destructive"
              />
              <div className="space-y-0.5">
                <Label htmlFor="destroy-container" className="cursor-pointer">
                  Also destroy the container
                </Label>
                <p className="font-mono text-xs text-muted-foreground">{server.containerName}</p>
              </div>
            </div>
            {destroy && (
              <p className="border-t border-border pt-3 text-sm text-destructive">
                The provisioner stops the server and deletes the container. World data stays on the
                host, so you can rebuild from New server later.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={deleteServer.isPending}
            onClick={() => deleteServer.mutate()}
          >
            {deleteServer.isPending
              ? destroy && canDestroy
                ? "Destroying…"
                : "Removing…"
              : destroy && canDestroy
                ? "Remove and destroy"
                : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
