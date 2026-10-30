import { t3PluginWeb } from "@t3tools/plugin-sdk/vite";
import { defineConfig } from "vite-plus";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [t3PluginWeb({ outDir: "." })],
  // The output sits beside the fixture's sources.
  build: { emptyOutDir: false, minify: false },
});
