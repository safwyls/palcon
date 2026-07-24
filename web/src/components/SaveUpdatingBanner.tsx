/**
 * Shown above already-loaded save data while a fresher parse runs in the
 * background. The world autosaves every ~30s and re-parsing a large save
 * takes a while, so rather than blanking the view (and making the user wait
 * again), the last result stays on screen with this quiet "it's updating"
 * cue over it.
 */
export function SaveUpdatingBanner() {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-brand-amber/30 bg-brand-amber/10 px-3 py-2 text-xs text-ink/60">
      <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-brand-amber border-t-transparent" />
      Showing the last read — checking for a newer save…
    </div>
  );
}
