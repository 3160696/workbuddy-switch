const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const excluded = new Set([
  ".git",
  "node_modules",
  "dist",
  "release",
  "artifacts",
]);
const privateName =
  /^(?:\.env(?:\..*)?|.*\.(?:info|db|sqlite|pem|key)|(?:dashboard-cache|model-observations|usage-ledger|settings|plugin-auth|logins|account-order|account-aliases|auth|credentials|secrets)\.json)$/i;
const patterns = [
  [
    "JWT credential",
    /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/,
  ],
  [
    "GitHub credential",
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/,
  ],
  ["API credential", /\bsk-(?:proj-)?[A-Za-z0-9_-]{28,}\b/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["personal Windows path", /\b[A-Z]:[\\/]+Users[\\/]+[A-Za-z0-9_-]+[\\/]/],
  ["credential in URL", /https?:\/\/[^\s/@:]+:[^\s/@]+@/],
];
const textExtensions =
  /\.(?:[cm]?js|jsx|tsx?|json|md|html|css|svg|ps1|ya?ml)$/i;
const findings = [];
let files = 0;
function walk(folder) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const file = path.join(folder, entry.name);
    const relative = path.relative(root, file).replaceAll(path.sep, "/");
    if (entry.isSymbolicLink())
      throw Error("Unexpected symbolic link: " + relative);
    if (entry.isDirectory()) {
      walk(file);
      continue;
    }
    files++;
    if (privateName.test(entry.name) && entry.name !== ".env.example")
      findings.push({ file: relative, reason: "private data filename" });
    if (!textExtensions.test(entry.name)) continue;
    const content = fs.readFileSync(file, "utf8");
    for (const [reason, pattern] of patterns)
      if (pattern.test(content)) findings.push({ file: relative, reason });
  }
}
walk(root);
if (findings.length) {
  console.error(JSON.stringify({ ok: false, findings }, null, 2));
  process.exitCode = 1;
} else
  console.log(
    JSON.stringify({
      ok: true,
      files,
      message:
        "Public files contain no detected credentials, private account files or personal Windows paths.",
    }),
  );
