import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev mode: Vite proxies API and generated media requests to the backend on 8790.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8790",
      "/outputs": "http://localhost:8790",
      "/resources": "http://localhost:8790",
      "/director-assets": "http://localhost:8790",
    },
  },
});
