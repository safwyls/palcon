/** Shown on save-backed views when the server has no save path configured.
 * Shared so the Pals and Guilds views can't drift out of sync. */
export function SavePathSetup() {
  return (
    <section className="rounded-2xl border border-ink/10 bg-white/70 p-6">
      <h2 className="font-display text-base font-bold">Set up save file reading</h2>
      <p className="mt-2 max-w-2xl text-sm text-ink/60">
        This reads the server's save file directly, so Palcon needs to see it. Bind-mount your world save
        folder (the one containing <code className="font-mono">Level.sav</code>) into the container{" "}
        <span className="font-semibold">read-only</span>, then put that container path in the server's{" "}
        <span className="font-semibold">Save path</span> (edit the server from the sidebar).
      </p>
      <pre className="mt-3 max-w-2xl overflow-x-auto rounded-lg bg-ink px-4 py-3 font-mono text-xs text-paper/80">
        - /path/to/Pal/Saved/SaveGames/0/&lt;world-id&gt;:/saves/myserver:ro
      </pre>
    </section>
  );
}
