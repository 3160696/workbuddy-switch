import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await fs.readFile(path.join(root, "assets/brand/icon.svg"));
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const pngs = await Promise.all(
  sizes.map((size) => sharp(source).resize(size, size).png().toBuffer()),
);
// ICO stores one directory entry per size. PNG frames preserve full alpha on Windows.
const head = Buffer.alloc(6 + sizes.length * 16);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(sizes.length, 4);
let offset = head.length;
for (let i = 0; i < sizes.length; i++) {
  const pos = 6 + i * 16;
  head[pos] = head[pos + 1] = sizes[i] === 256 ? 0 : sizes[i];
  head.writeUInt16LE(1, pos + 4);
  head.writeUInt16LE(32, pos + 6);
  head.writeUInt32LE(pngs[i].length, pos + 8);
  head.writeUInt32LE(offset, pos + 12);
  offset += pngs[i].length;
}
await fs.mkdir(path.join(root, "public"), { recursive: true });
await Promise.all([
  fs.writeFile(
    path.join(root, "electron/icon.ico"),
    Buffer.concat([head, ...pngs]),
  ),
  sharp(source)
    .resize(512, 512)
    .png()
    .toFile(path.join(root, "electron/icon.png")),
  sharp(source)
    .resize(1024, 1024)
    .png()
    .toFile(path.join(root, "assets/brand/icon-1024.png")),
  fs.writeFile(path.join(root, "public/favicon.svg"), source),
]);
console.log(
  "Generated app, installer, shortcut and favicon assets from assets/brand/icon.svg.",
);
