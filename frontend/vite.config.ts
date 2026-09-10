import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Built assets are served by the Python backend from frontend/dist, so use relative base.
// In dev, proxy the API + SSE to the backend so the app runs the same in both.
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    port: 3000,
    proxy: {
      "/api": "http://127.0.0.1:51770",
      "/events": { target: "http://127.0.0.1:51770", ws: false },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
