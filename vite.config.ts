import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;
const distribution = resolve(root, "dist");

function copyModuleFiles(): Plugin {
  return {
    name: "copy-module-files",
    async closeBundle() {
      await mkdir(distribution, { recursive: true });
      await Promise.all([
        cp(resolve(root, "module.json"), resolve(distribution, "module.json")),
        cp(resolve(root, "LICENSE"), resolve(distribution, "LICENSE")),
        cp(resolve(root, "README.md"), resolve(distribution, "README.md")),
        cp(resolve(root, "lang"), resolve(distribution, "lang"), { recursive: true }),
      ]);
    },
  };
}

export default defineConfig({
  plugins: [copyModuleFiles()],
  build: {
    emptyOutDir: true,
    outDir: distribution,
    sourcemap: true,
    lib: {
      entry: resolve(root, "src/main.ts"),
      formats: ["es"],
      fileName: () => "scripts/main.js",
    },
    rollupOptions: {
      output: {
        entryFileNames: "scripts/main.js",
      },
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
