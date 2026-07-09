import { createWriteStream } from "node:fs";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import archiver from "archiver";

const root = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(root, "package");
const manifest = JSON.parse(await readFile(resolve(root, "module.json"), "utf8"));
const archivePath = resolve(outputDirectory, `${manifest.id}-v${manifest.version}.zip`);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await cp(resolve(root, "dist", "module.json"), resolve(outputDirectory, "module.json"));

await new Promise((resolveArchive, reject) => {
  const output = createWriteStream(archivePath);
  const archive = archiver("zip", { zlib: { level: 9 } });
  output.on("close", resolveArchive);
  output.on("error", reject);
  archive.on("error", reject);
  archive.pipe(output);
  archive.directory(resolve(root, "dist"), false);
  void archive.finalize();
});

console.log(`Created ${archivePath}.`);
