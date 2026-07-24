import { useEffect, useState } from "react";

/**
 * Shown while the save file is being read.
 *
 * The bar is indeterminate on purpose: parsing happens in a one-shot Python
 * process, so there's no progress to report, and a percentage would be
 * invented. Elapsed seconds are real, and after a while the copy explains
 * what's taking time instead of leaving the page looking hung.
 */
export function SaveReadProgress() {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <section className="rounded-2xl border border-ink/10 bg-white/70 p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-base font-bold">Reading save file…</h2>
        <span className="font-mono text-xs text-ink/40">{seconds}s</span>
      </div>

      <div
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink/10"
        role="progressbar"
        aria-label="Reading save file"
      >
        <div className="h-full w-1/3 animate-[saveread_1.4s_ease-in-out_infinite] rounded-full bg-brand-red" />
      </div>

      <p className="mt-3 max-w-2xl text-sm text-ink/50">
        {seconds < 8
          ? "Parsing the world's character data."
          : "Still going — a large world takes longer on the first read. Once parsed, the result is cached until the game next autosaves."}
      </p>
    </section>
  );
}
