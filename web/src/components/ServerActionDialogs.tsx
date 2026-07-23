import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Megaphone, Power } from "lucide-react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

export function BroadcastDialog({
  serverId,
  open,
  onOpenChange,
}: {
  serverId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [message, setMessage] = useState("");

  const broadcast = useMutation({
    mutationFn: (msg: string) => api.broadcast(serverId, msg),
    onSuccess: () => {
      toast.success("Broadcast sent");
      setMessage("");
      onOpenChange(false);
    },
    onError: () => toast.error("Failed to send broadcast"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Broadcast a message</DialogTitle>
          <DialogDescription>Shown in-game to every player currently online.</DialogDescription>
        </DialogHeader>
        <Input
          placeholder="Server restarting in 10 minutes…"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && message) broadcast.mutate(message);
          }}
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!message || broadcast.isPending} onClick={() => broadcast.mutate(message)}>
            <Megaphone className="h-4 w-4" />
            {broadcast.isPending ? "Sending..." : "Send"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ShutdownDialog({
  serverId,
  open,
  onOpenChange,
}: {
  serverId: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [waitSeconds, setWaitSeconds] = useState(60);
  const [message, setMessage] = useState("Server restarting soon");

  const shutdown = useMutation({
    mutationFn: () => api.shutdown(serverId, waitSeconds, message),
    onSuccess: () => {
      toast.success("Shutdown initiated");
      onOpenChange(false);
    },
    onError: () => toast.error("Shutdown failed"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Shut down server?</DialogTitle>
          <DialogDescription>
            Players get the message below, then the server stops after the wait period.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <div className="w-24 space-y-1">
            <Label className="text-xs">Wait (s)</Label>
            <Input type="number" value={waitSeconds} onChange={(e) => setWaitSeconds(Number(e.target.value))} />
          </div>
          <div className="flex-1 space-y-1">
            <Label className="text-xs">Message</Label>
            <Input value={message} onChange={(e) => setMessage(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={shutdown.isPending} onClick={() => shutdown.mutate()}>
            <Power className="h-4 w-4" />
            {shutdown.isPending ? "Shutting down..." : "Shut down"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
