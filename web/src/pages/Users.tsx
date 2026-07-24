import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, PERMISSIONS, PERMISSION_LABELS, type AppUser, type Permission } from "../lib/api";
import { useAuth } from "../lib/auth";
import { initials, playerColor } from "../lib/palette";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";

function PermissionPicker({
  value,
  disabled,
  onChange,
}: {
  value: Permission[];
  disabled?: boolean;
  onChange: (next: Permission[]) => void;
}) {
  return (
    <div className="space-y-2">
      {PERMISSIONS.map((p) => {
        const checked = value.includes(p);
        return (
          <label
            key={p}
            className={cn(
              "flex cursor-pointer items-start gap-3 rounded-lg border p-2.5 transition-colors",
              checked ? "border-brand-red/30 bg-brand-red/5" : "border-ink/10 hover:bg-ink/[0.03]",
              disabled && "cursor-not-allowed opacity-50",
            )}
          >
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-brand-red"
              checked={checked}
              disabled={disabled}
              onChange={(e) => onChange(e.target.checked ? [...value, p] : value.filter((x) => x !== p))}
            />
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-ink">{PERMISSION_LABELS[p].label}</span>
              <span className="block text-xs text-ink/50">{PERMISSION_LABELS[p].help}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

function UserDialog({
  user,
  open,
  onOpenChange,
}: {
  user: AppUser | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const editing = user !== null;
  const [username, setUsername] = useState(user?.username ?? "");
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(user?.role === "admin");
  const [permissions, setPermissions] = useState<Permission[]>(user?.permissions ?? []);
  const [disabled, setDisabled] = useState(user?.disabled ?? false);

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        role: isAdmin ? "admin" : "user",
        permissions,
        disabled,
        ...(password ? { password } : {}),
      };
      return editing
        ? api.updateUser(user.id, payload)
        : api.createUser({ ...payload, username, password });
    },
    onSuccess: () => {
      toast.success(editing ? "User updated" : "User created");
      queryClient.invalidateQueries({ queryKey: ["users"] });
      onOpenChange(false);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to save user"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${user.username}` : "Add a user"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Leave the password blank to keep the current one."
              : "Give a player an account so they can sign in and use whatever you grant below."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!editing && (
            <div className="space-y-1.5">
              <Label>Username</Label>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
            </div>
          )}
          <div className="space-y-1.5">
            <Label>{editing ? "New password" : "Password"}</Label>
            <Input
              type="password"
              value={password}
              placeholder={editing ? "unchanged" : "at least 8 characters"}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <div className="flex items-center gap-2">
            <Switch id="is-admin" checked={isAdmin} onCheckedChange={setIsAdmin} />
            <Label htmlFor="is-admin" className="text-foreground">
              Administrator
            </Label>
          </div>
          <p className="-mt-2 text-xs text-ink/50">
            Admins can do everything, including managing servers and other users.
          </p>

          <div>
            <Label className="mb-2 block">Permissions</Label>
            <PermissionPicker value={permissions} disabled={isAdmin} onChange={setPermissions} />
            {isAdmin && <p className="mt-2 text-xs text-ink/50">Administrators already have every permission.</p>}
          </div>

          {editing && (
            <div className="flex items-center gap-2">
              <Switch id="disabled" checked={disabled} onCheckedChange={setDisabled} />
              <Label htmlFor="disabled" className="text-foreground">
                Disable this account
              </Label>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : editing ? "Save changes" : "Create user"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function Users() {
  const { username: me } = useAuth();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<AppUser | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<AppUser | null>(null);

  const usersQuery = useQuery({ queryKey: ["users"], queryFn: api.listUsers });

  const remove = useMutation({
    mutationFn: (u: AppUser) => api.deleteUser(u.id),
    onSuccess: () => {
      toast.success("User removed");
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setConfirmDelete(null);
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to remove user"),
  });

  const openNew = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (u: AppUser) => {
    setEditing(u);
    setDialogOpen(true);
  };

  return (
    <div>
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-ink/10 bg-paper px-4 py-5 lg:px-8 lg:py-6">
        <div>
          <h1 className="font-display text-xl font-extrabold lg:text-2xl">Users</h1>
          <p className="mt-0.5 text-sm text-ink/50">Who can sign in, and what they're allowed to do</p>
        </div>
        <Button className="clip-notch" onClick={openNew}>
          <Plus className="h-4 w-4" />
          Add user
        </Button>
      </header>

      <div className="space-y-3 p-4 lg:p-8">
        {usersQuery.isLoading && <p className="text-sm text-muted-foreground">Loading users…</p>}
        {usersQuery.isError && <p className="text-sm text-destructive">Failed to load users.</p>}

        {usersQuery.data?.map((u) => {
          const color = playerColor(u.username);
          return (
            <section
              key={u.id}
              className="flex flex-wrap items-center gap-3 rounded-2xl border border-ink/10 bg-white/70 p-4"
            >
              <span
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full font-display text-sm font-bold"
                style={{ backgroundColor: `${color}33`, color }}
              >
                {initials(u.username)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-display text-base font-bold">
                  {u.username}
                  {u.username === me && <span className="ml-2 text-xs font-normal text-ink/40">you</span>}
                  {u.disabled && <span className="ml-2 text-xs font-normal text-destructive">disabled</span>}
                </p>
                <p className="font-mono text-xs text-ink/45">
                  {u.role === "admin"
                    ? "administrator · all permissions"
                    : u.permissions.length
                      ? u.permissions.map((p) => PERMISSION_LABELS[p].label).join(", ")
                      : "view only"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => openEdit(u)}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  title="Remove user"
                  className="text-ink/40 hover:text-destructive"
                  onClick={() => setConfirmDelete(u)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </section>
          );
        })}
      </div>

      {dialogOpen && (
        <UserDialog
          // Remount per target so the form starts from that user's values.
          key={editing?.id ?? "new"}
          user={editing}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
        />
      )}

      <Dialog open={confirmDelete !== null} onOpenChange={(open) => !open && setConfirmDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {confirmDelete?.username}?</DialogTitle>
            <DialogDescription>They'll lose access immediately. This can't be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => confirmDelete && remove.mutate(confirmDelete)}
            >
              {remove.isPending ? "Removing…" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
