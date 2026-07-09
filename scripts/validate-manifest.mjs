import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(resolve(root, "module.json"), "utf8"));
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));

const errors = [];
if (manifest.id !== packageJson.name) errors.push("module id must match package name");
if (manifest.version !== packageJson.version) errors.push("module and package versions must match");
if (manifest.compatibility?.minimum !== "14") errors.push("minimum Foundry version must be 14");
if (manifest.compatibility?.verified !== "14") errors.push("verified Foundry version must be 14");

for (const path of [...(manifest.esmodules ?? []), ...(manifest.languages ?? []).map(({ path }) => path)]) {
  try {
    await access(resolve(root, "dist", path));
  } catch {
    errors.push(`built file is missing: ${path}`);
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated ${manifest.id} v${manifest.version}.`);
}
