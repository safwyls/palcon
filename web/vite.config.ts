import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server proxies /api to the Go backend so `npm run dev` works against
// a locally running `go run ./cmd/palcon` without CORS headaches.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8080",
    },
  },
  build: {
    outDir: "dist",
  },
});
