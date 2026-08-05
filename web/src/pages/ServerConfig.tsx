import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Eye, EyeOff, Lock, Search } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError, type ConfigResult, type ConfigSetting } from "../lib/api";
import { useAuth } from "../lib/auth";
import { VisibilityPanel } from "../components/VisibilityPanel";
import { cn } from "../lib/utils";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";

/** The one empty settings list, so "no config loaded" keeps a stable
 * identity across renders. See the note where it's used. */
const NO_SETTINGS: ConfigSetting[] = [];

/** Floats come off disk as "1.000000"; show the trimmed form everywhere so
 * the editor reads cleanly. The backend re-expands to %.6f on save, so the
 * baseline we compare against uses the same trimmed form. */
function display(s: ConfigSetting): string {
  if (s.type === "float") {
    const n = parseFloat(s.value);
    if (!Number.isNaN(n)) return String(n);
  }
  return s.value;
}

const isSecret = (key: string) => /password/i.test(key);

type Control = "text" | "password" | "toggle" | "select" | "rate" | "int";
interface CommonField {
  key: string;
  label: string;
  control: Control;
  options?: string[];
  hint?: string;
}

// Curated groups shown up top. A field renders only if its key is actually
// present in the parsed file, so a game update that renames a key just drops
// it from Common — it stays editable in the full list below.
const COMMON_GROUPS: { title: string; fields: CommonField[] }[] = [
  {
    title: "Identity & access",
    fields: [
      { key: "ServerName", label: "Server name", control: "text" },
      { key: "ServerDescription", label: "Description", control: "text" },
      { key: "ServerPassword", label: "Join password", control: "password", hint: "Blank = open server" },
      { key: "AdminPassword", label: "Admin password", control: "password", hint: "Used by RCON and the REST API" },
      { key: "ServerPlayerMaxNum", label: "Max players", control: "int" },
    ],
  },
  {
    title: "World & rules",
    fields: [
      { key: "Difficulty", label: "Difficulty", control: "select", options: ["None", "Casual", "Normal", "Hard"] },
      {
        key: "DeathPenalty",
        label: "Death penalty",
        control: "select",
        options: ["None", "Item", "ItemAndEquipment", "All"],
      },
      { key: "bEnablePlayerToPlayerDamage", label: "PvP damage", control: "toggle" },
      { key: "bEnableFriendlyFire", label: "Friendly fire", control: "toggle" },
      { key: "bEnableInvaderEnemy", label: "Raids on bases", control: "toggle" },
      { key: "BaseCampMaxNum", label: "Max bases", control: "int" },
      { key: "GuildPlayerMaxNum", label: "Max guild members", control: "int" },
    ],
  },
  {
    title: "Rates",
    fields: [
      { key: "ExpRate", label: "EXP", control: "rate" },
      { key: "PalCaptureRate", label: "Capture", control: "rate" },
      { key: "CollectionDropRate", label: "Gather", control: "rate" },
      { key: "PalDamageRateAttack", label: "Pal damage dealt", control: "rate" },
      { key: "PlayerDamageRateAttack", label: "Player damage dealt", control: "rate" },
      { key: "WorkSpeedRate", label: "Work speed", control: "rate" },
      { key: "DayTimeSpeedRate", label: "Day length", control: "rate" },
      { key: "NightTimeSpeedRate", label: "Night length", control: "rate" },
    ],
  },
];

export function ServerConfig() {
  const { serverID } = useParams();
  const id = Number(serverID);
  const queryClient = useQueryClient();
  const { can, isAdmin } = useAuth();

  const serverQuery = useQuery({ queryKey: ["server", id], queryFn: () => api.getServer(id) });
  const configQuery = useQuery({
    queryKey: ["server-config", id],
    queryFn: () => api.serverConfig(id),
    retry: false,
  });

  // Hoisted rather than written inline: `?? []` mints a new array on every
  // render, which changes `baseline`'s identity, which re-fires the effect
  // below, which sets state and renders again — forever. That happens
  // whenever the query has no data, including permanently on a server with
  // no config path, where the request 400s and never retries.
  const settings = configQuery.data?.settings ?? NO_SETTINGS;
  const baseline = useMemo(
    () => Object.fromEntries(settings.map((s) => [s.key, display(s)])),
    [settings],
  );

  const [draft, setDraft] = useState<Record<string, string>>({});
  const [diskChanged, setDiskChanged] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const prevBaselineRef = useRef<Record<string, string> | null>(null);

  // When the file genuinely changes on disk (server rewrote it, someone
  // else saved) while edits are pending, carry the edits onto the new
  // baseline and say so — silently wiping them loses the admin's work.
  // With no pending edits (first load, discard, post-save refetch) the
  // draft just tracks the baseline as before.
  useEffect(() => {
    const prev = prevBaselineRef.current;
    prevBaselineRef.current = baseline;
    const d = draftRef.current;
    const hadEdits = prev !== null && Object.keys(prev).some((k) => d[k] !== undefined && d[k] !== prev[k]);
    if (!hadEdits) {
      setDraft(baseline);
      return;
    }
    const merged = { ...baseline };
    for (const k of Object.keys(prev)) {
      if (d[k] !== undefined && d[k] !== prev[k] && k in merged) merged[k] = d[k];
    }
    setDraft(merged);
    // A save's own refetch absorbs the edits (merged == baseline); only
    // warn when unsaved edits actually sit on top of changed data.
    if (Object.keys(merged).some((k) => merged[k] !== baseline[k])) setDiskChanged(true);
  }, [baseline]);

  const dirtyKeys = Object.keys(baseline).filter((k) => draft[k] !== baseline[k]);
  const setField = (key: string, value: string) => setDraft((d) => ({ ...d, [key]: value }));

  const save = useMutation({
    mutationFn: () => {
      const changes: Record<string, string> = {};
      for (const k of dirtyKeys) changes[k] = draft[k];
      return api.updateServerConfig(id, changes);
    },
    onSuccess: (result: ConfigResult) => {
      queryClient.setQueryData(["server-config", id], result);
      const server = serverQuery.data;
      if (server?.containerName && can("power")) {
        toast.success("Settings saved — restart to apply", {
          action: {
            label: "Restart now",
            onClick: () => {
              const p = api.containerAction(id, "restart");
              toast.promise(p, { loading: "Restarting…", success: "Restart requested", error: "Restart failed" });
              queryClient.invalidateQueries({ queryKey: ["container", id] });
            },
          },
        });
      } else {
        toast.success("Settings saved — restart the server to apply");
      }
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to save settings"),
  });

  if (serverQuery.isLoading) return <p className="p-6 text-muted-foreground">Loading…</p>;
  if (serverQuery.isError || !serverQuery.data)
    return <p className="p-6 text-destructive">Server not found.</p>;

  const notConfigured =
    configQuery.isError && configQuery.error instanceof ApiError && configQuery.error.status === 400;
  const forbidden =
    configQuery.isError && configQuery.error instanceof ApiError && configQuery.error.status === 403;

  return (
    <div className="pb-24">
      <header className="sticky top-0 z-10 hidden items-center justify-between border-b border-ink/10 bg-paper px-8 py-6 lg:flex">
        <div>
          <h1 className="font-display text-2xl font-extrabold">Server settings</h1>
          <p className="mt-0.5 text-sm text-ink/50">
            {serverQuery.data.name} · PalWorldSettings.ini
          </p>
        </div>
        {configQuery.data && (
          <span className="font-mono text-xs text-ink/40">{settings.length} options</span>
        )}
      </header>

      <div className="space-y-4 p-4 lg:space-y-6 lg:p-8">
        {/* Above the ini editor on purpose: this is the setting most likely to
            be changed on someone else's behalf, and it works without a config
            path, which the editor below doesn't. */}
        {isAdmin && <VisibilityPanel serverId={id} />}

        {configQuery.isLoading && <p className="text-sm text-muted-foreground">Reading settings…</p>}
        {notConfigured && <ConfigPathSetup />}
        {forbidden && (
          <p className="text-sm text-muted-foreground">You don't have permission to edit settings.</p>
        )}
        {configQuery.isError && !notConfigured && !forbidden && (
          <p className="text-sm text-destructive">
            {(configQuery.error as Error).message}
          </p>
        )}

        {configQuery.data && (
          <>
            {!configQuery.data.writable && (
              <div className="flex items-center gap-2 rounded-lg border border-brand-amber/40 bg-brand-amber/10 px-3 py-2 text-sm text-ink/70">
                <Lock className="h-4 w-4 shrink-0 text-brand-amber" />
                This config file is mounted read-only. Remount it read-write to save changes.
              </div>
            )}
            {diskChanged && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-brand-amber/40 bg-brand-amber/10 px-3 py-2 text-sm text-ink/70">
                <span>
                  The settings file changed on disk while you were editing. Your unsaved edits are kept on top of the
                  new values — review them before saving.
                </span>
                <button
                  onClick={() => setDiskChanged(false)}
                  className="shrink-0 text-xs font-semibold text-ink/50 hover:text-ink hover:underline"
                >
                  Dismiss
                </button>
              </div>
            )}
            <p className="font-mono text-[11px] text-ink/30">{configQuery.data.path}</p>

            <CommonSettings
              settings={settings}
              draft={draft}
              baseline={baseline}
              setField={setField}
            />
            <AllSettings settings={settings} draft={draft} baseline={baseline} setField={setField} />
          </>
        )}
      </div>

      {configQuery.data && dirtyKeys.length > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-ink/10 bg-paper/95 px-4 py-3 backdrop-blur lg:pl-64">
          <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
            <span className="text-sm text-ink/60">
              {dirtyKeys.length} unsaved {dirtyKeys.length === 1 ? "change" : "changes"}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  setDraft(baseline);
                  setDiskChanged(false);
                }}
                disabled={save.isPending}
                className="rounded-lg border border-ink/15 bg-white px-4 py-2 font-display text-sm font-bold text-ink transition hover:bg-ink/5 disabled:opacity-50"
              >
                Discard
              </button>
              <button
                onClick={() => save.mutate()}
                disabled={save.isPending || !configQuery.data.writable}
                className="rounded-lg bg-brand-red px-4 py-2 font-display text-sm font-bold text-paper transition hover:brightness-110 disabled:opacity-50"
              >
                {save.isPending ? "Saving…" : "Save changes"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, hint, changed, children }: {
  label: string;
  hint?: string;
  changed: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-foreground">{label}</span>
          {changed && <span className="h-1.5 w-1.5 rounded-full bg-brand-amber" title="Unsaved change" />}
        </div>
        {hint && <p className="text-xs text-ink/40">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function CommonSettings({ settings, draft, baseline, setField }: {
  settings: ConfigSetting[];
  draft: Record<string, string>;
  baseline: Record<string, string>;
  setField: (key: string, value: string) => void;
}) {
  const present = new Set(settings.map((s) => s.key));
  return (
    <div className="space-y-4">
      {COMMON_GROUPS.map((group) => {
        const fields = group.fields.filter((f) => present.has(f.key));
        if (fields.length === 0) return null;
        return (
          <section key={group.title} className="overflow-hidden rounded-2xl border border-ink/10 bg-white/70">
            <h2 className="border-b border-ink/10 px-5 py-3 text-xs font-semibold uppercase tracking-wide text-ink/50">
              {group.title}
            </h2>
            <div className="divide-y divide-ink/5 px-5">
              {fields.map((f) => (
                <Row key={f.key} label={f.label} hint={f.hint} changed={draft[f.key] !== baseline[f.key]}>
                  <CommonControl field={f} value={draft[f.key] ?? ""} onChange={(v) => setField(f.key, v)} />
                </Row>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function CommonControl({ field, value, onChange }: {
  field: CommonField;
  value: string;
  onChange: (v: string) => void;
}) {
  switch (field.control) {
    case "toggle":
      return (
        <Switch checked={value.toLowerCase() === "true"} onCheckedChange={(c) => onChange(c ? "True" : "False")} />
      );
    case "select":
      return (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-44 rounded-lg border border-ink/15 bg-white px-2.5 py-1.5 text-sm"
        >
          {/* Keep an unexpected on-disk value selectable rather than silently dropping it. */}
          {!field.options?.includes(value) && <option value={value}>{value}</option>}
          {field.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case "rate":
      return <RateControl value={value} onChange={onChange} />;
    case "int":
      return (
        <Input
          type="number"
          step="1"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-28 text-right"
        />
      );
    case "password":
      return <SecretInput value={value} onChange={onChange} className="w-56" />;
    default:
      return <Input value={value} onChange={(e) => onChange(e.target.value)} className="w-56" />;
  }
}

function RateControl({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const n = parseFloat(value);
  const slider = Number.isNaN(n) ? 1 : Math.min(5, Math.max(0, n));
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={0}
        max={5}
        step={0.05}
        value={slider}
        onChange={(e) => onChange(String(parseFloat(e.target.value)))}
        className="w-32 accent-brand-red"
      />
      <div className="flex items-center gap-1">
        <span className="text-ink/40">×</span>
        <Input
          type="number"
          step="0.1"
          min={0}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-20 text-right"
        />
      </div>
    </div>
  );
}

function SecretInput({ value, onChange, className }: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className={cn("relative", className)}>
      <Input
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="pr-9"
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-ink/40 hover:text-ink"
        title={show ? "Hide" : "Reveal"}
      >
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

function AllSettings({ settings, draft, baseline, setField }: {
  settings: ConfigSetting[];
  draft: Record<string, string>;
  baseline: Record<string, string>;
  setField: (key: string, value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q ? settings.filter((s) => s.key.toLowerCase().includes(q)) : settings;

  return (
    <section className="overflow-hidden rounded-2xl border border-ink/10 bg-white/70">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-5 py-4 text-left"
      >
        <div>
          <h2 className="font-display text-base font-bold">All settings</h2>
          <p className="text-xs text-ink/40">Every key in PalWorldSettings.ini ({settings.length})</p>
        </div>
        <ChevronDown className={cn("h-5 w-5 text-ink/40 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="border-t border-ink/10">
          <div className="relative px-5 py-3">
            <Search className="absolute left-7 top-1/2 h-4 w-4 -translate-y-1/2 text-ink/30" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter settings…"
              className="pl-8"
            />
          </div>
          <div className="max-h-[32rem] divide-y divide-ink/5 overflow-y-auto px-5">
            {shown.map((s) => (
              <Row key={s.key} label={s.key} changed={draft[s.key] !== baseline[s.key]}>
                <RawControl setting={s} value={draft[s.key] ?? ""} onChange={(v) => setField(s.key, v)} />
              </Row>
            ))}
            {shown.length === 0 && <p className="py-4 text-sm text-muted-foreground">No matching settings.</p>}
          </div>
        </div>
      )}
    </section>
  );
}

function RawControl({ setting, value, onChange }: {
  setting: ConfigSetting;
  value: string;
  onChange: (v: string) => void;
}) {
  if (setting.type === "bool") {
    return (
      <Switch checked={value.toLowerCase() === "true"} onCheckedChange={(c) => onChange(c ? "True" : "False")} />
    );
  }
  if (setting.type === "int" || setting.type === "float") {
    return (
      <Input
        type="number"
        step={setting.type === "float" ? "any" : "1"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-32 text-right"
      />
    );
  }
  if (isSecret(setting.key)) {
    return <SecretInput value={value} onChange={onChange} className="w-56" />;
  }
  return <Input value={value} onChange={(e) => onChange(e.target.value)} className="w-56" />;
}

function ConfigPathSetup() {
  return (
    <section className="rounded-2xl border border-ink/10 bg-white/70 p-6">
      <h2 className="font-display text-base font-bold">Set up settings editing</h2>
      <p className="mt-2 max-w-2xl text-sm text-ink/60">
        To edit <code className="font-mono">PalWorldSettings.ini</code>, bind-mount the folder that holds it{" "}
        <span className="font-semibold">read-write</span> — kept separate from the read-only save mount so your
        save data stays untouchable — then put that container path in the server's{" "}
        <span className="font-semibold">Config path</span> (edit the server from the sidebar).
      </p>
      <pre className="mt-3 max-w-2xl overflow-x-auto rounded-lg bg-ink px-4 py-3 font-mono text-xs text-paper/80">
        - /path/to/Pal/Saved/Config/LinuxServer:/config/myserver
      </pre>
      <p className="mt-2 text-xs text-ink/40">
        Changes take effect the next time the server restarts.
      </p>
    </section>
  );
}
