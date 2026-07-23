import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, type Server, type ServerWriteInput } from "../lib/api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";

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

function formStateFor(mode: "create" | "edit", server?: Server): ServerWriteInput {
  if (mode === "edit" && server) {
    return {
      name: server.name,
      host: server.host,
      rconPort: server.rconPort,
      rconPassword: "",
      restPort: server.restPort,
      restPassword: "",
      useRest: server.useRest,
      enabled: server.enabled,
    };
  }
  return emptyForm;
}

export function ServerFormDialog({
  open,
  onOpenChange,
  mode,
  server,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "edit";
  server?: Server;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<ServerWriteInput>(() => formStateFor(mode, server));

  // Reset to fresh values every time the dialog opens, so stale form state
  // from a previous open (or a different server, in edit mode) doesn't leak in.
  useEffect(() => {
    if (open) setForm(formStateFor(mode, server));
  }, [open, mode, server]);

  const save = useMutation({
    mutationFn: (input: ServerWriteInput) =>
      mode === "create" ? api.createServer(input) : api.updateServer(server!.id, input),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["servers"] });
      if (mode === "edit") queryClient.invalidateQueries({ queryKey: ["server", result.id] });
      toast.success(mode === "create" ? `Added "${result.name}"` : `Updated "${result.name}"`);
      onOpenChange(false);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to save server"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onClick={(e) => e.stopPropagation()}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(form);
          }}
        >
          <DialogHeader>
            <DialogTitle>{mode === "create" ? "Add a Palworld server" : `Edit "${server?.name}"`}</DialogTitle>
            <DialogDescription>
              Credentials come from your server's <code>PalWorldSettings.ini</code>.
              {mode === "edit" && " Leave a password blank to keep the current one."}
            </DialogDescription>
          </DialogHeader>

          <div className="mt-4 grid grid-cols-2 gap-3">
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
              placeholder={mode === "edit" && server?.hasRestPassword ? "unchanged" : undefined}
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
              placeholder={mode === "edit" && server?.hasRconPassword ? "unchanged" : undefined}
            />
          </div>

          <div className="mt-4 flex items-center gap-2">
            <Switch
              id="use-rest"
              checked={form.useRest}
              onCheckedChange={(checked) => setForm({ ...form, useRest: checked })}
            />
            <Label htmlFor="use-rest" className="text-foreground">
              Prefer REST API (falls back to RCON)
            </Label>
          </div>

          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" className="clip-notch" disabled={save.isPending}>
              {save.isPending ? "Saving..." : mode === "create" ? "Add server" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
