// Reuse the installed Electron runtime; build only the local application archive.
const fs = require("node:fs");
const path = require("node:path");
const { createPackage } = require("@electron/asar");

(async () => {
  const root = path.resolve(__dirname, "..");
  const folder = path.join(root, "artifacts", "local-" + Date.now());
  const stage = path.join(folder, "app");
  fs.mkdirSync(stage, { recursive: true });
  for (const name of ["dist", "electron"]) {
    fs.cpSync(path.join(root, name), path.join(stage, name), {
      recursive: true,
    });
  }
  fs.copyFileSync(
    path.join(root, "package.json"),
    path.join(stage, "package.json"),
  );
  await createPackage(stage, path.join(folder, "app.asar"));
  fs.copyFileSync(
    path.join(root, "scripts", "workbuddy-process.ps1"),
    path.join(folder, "workbuddy-process.ps1"),
  );
  fs.copyFileSync(
    path.join(root, "scripts", "codebuddy-process.ps1"),
    path.join(folder, "codebuddy-process.ps1"),
  );
  console.log(folder);
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
