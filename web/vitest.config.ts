import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Kept separate from vite.config.ts so the production build never parses
// test-only config, and so `vitest` doesn't inherit the dev server's /api
// proxy — tests stub fetch instead of reaching a backend.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "html"],
      // The measured surface is the code we write. Generated/vendored
      // shims, the shadcn primitives (upstream-maintained, no logic of
      // ours), and the ~2 MB demo fixture would each dominate the number
      // without saying anything about our own correctness.
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/test/**",
        "src/main.tsx",
        "src/vite-env.d.ts",
        "src/components/ui/**",
        // The demo-mode request mock and its ~2 MB fixture are compiled
        // out of normal builds entirely (VITE_DEMO), so measuring them
        // says nothing about the shipped app.
        "src/lib/demo.ts",
        "src/demo/**",
        "src/data/**",
      ],
    },
  },
});
