const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { DatabaseSync, backup } = require("node:sqlite");
const { backupList } = require("./local-data.cjs");

const hash = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function within(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative))
    throw new Error("备份路径无效");
  const file = path.resolve(root, relative);
  if (!file.startsWith(path.resolve(root) + path.sep))
    throw new Error("备份路径越界");
  let cursor = file;
  while (cursor !== path.resolve(root)) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink())
      throw new Error("备份中包含链接，已停止操作");
    cursor = path.dirname(cursor);
  }
  return file;
}
class BackupStore {
  constructor(backend) {
    this.backend = backend;
    this.root = path.join(backend.dataDir, "backups");
    this.busy = false;
  }
  directory(id) {
    if (typeof id !== "string" || !/^[\w.-]+$/.test(id) || id.startsWith("."))
      throw new Error("备份标识无效");
    const folder = within(this.root, id);
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory())
      throw new Error("备份不存在");
    return folder;
  }
  list() {
    return backupList(this.backend.dataDir)
      .filter((b) => !b.name.startsWith("."))
      .map((b) => {
        try {
          const m = JSON.parse(
            fs.readFileSync(
              path.join(this.directory(b.name), "manifest.json"),
              "utf8",
            ),
          );
          return {
            ...b,
            client: m.client,
            kind: m.kind,
            files: m.files.length,
            bytes: m.files.reduce((n, f) => n + f.bytes, 0),
            verified: true,
            accounts: !!m.files.find((f) => f.path.startsWith("accounts/")),
          };
        } catch {
          return { ...b, client: "workbuddy", kind: "switch", verified: false };
        }
      });
  }
  async create(client = "all", kind = "manual") {
    if (!["all", "workbuddy", "codebuddy"].includes(client))
      throw new Error("未知客户端");
    if (this.busy) throw new Error("备份正在进行，请稍后重试");
    this.busy = true;
    fs.mkdirSync(this.root, { recursive: true });
    const id =
      new Date().toISOString().replace(/[:.]/g, "-") +
      "-" +
      randomUUID().slice(0, 8);
    const stage = path.join(this.root, ".partial-" + id),
      final = path.join(this.root, id);
    const manifest = { version: 1, client, kind, at: Date.now(), files: [] };
    try {
      fs.mkdirSync(stage);
      const copy = async (source, relative) => {
        if (!fs.existsSync(source)) return;
        const info = fs.lstatSync(source);
        if (info.isSymbolicLink())
          throw new Error("数据目录包含链接，请先检查备份范围");
        if (info.isDirectory()) {
          for (const name of fs.readdirSync(source))
            await copy(path.join(source, name), relative + "/" + name);
          return;
        }
        if (!info.isFile() || /(?:-wal|-shm|-journal|\.tmp)$/.test(source))
          return;
        const target = within(stage, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        if (/\.(?:db|vscdb)$/i.test(source)) {
          const db = new DatabaseSync(source, { readOnly: true });
          try {
            if (backup) await backup(db, target);
            else db.exec("VACUUM INTO '" + target.replace(/'/g, "''") + "'");
          } finally {
            db.close();
          }
        } else fs.copyFileSync(source, target);
        manifest.files.push({
          path: relative,
          bytes: fs.statSync(target).size,
          sha256: hash(target),
        });
      };
      await copy(this.backend.native.folder, "accounts");
      if (client !== "codebuddy") {
        await copy(this.backend.nativeAuth, "workbuddy/auth.info");
        const base = path.join(this.backend.home, ".workbuddy");
        for (const name of [
          "workbuddy.db",
          "projects",
          "sessions",
          "blobs",
          "clipboard-images",
          "plans",
          "memory",
          "tasks",
        ])
          await copy(path.join(base, name), "workbuddy/" + name);
      }
      if (client !== "workbuddy") {
        const profile = this.backend.codebuddy.profile;
        for (const name of [
          "Local State",
          "codebuddy-sessions.vscdb",
          "automations",
          "Backups",
          "User/globalStorage",
          "User/workspaceStorage",
          "User/History",
          "User/settings.json",
          "User/snippets",
        ])
          await copy(path.join(profile, name), "codebuddy/" + name);
      }
      if (!manifest.files.length) throw new Error("没有可备份的数据");
      fs.writeFileSync(
        path.join(stage, "manifest.json"),
        JSON.stringify(manifest, null, 2),
        { mode: 0o600 },
      );
      fs.renameSync(stage, final);
      return {
        name: id,
        files: manifest.files.length,
        bytes: manifest.files.reduce((n, f) => n + f.bytes, 0),
      };
    } catch {
      // Remove only the verified staging folder created by this operation.
      if (fs.existsSync(stage))
        fs.rmSync(within(this.root, path.basename(stage)), {
          recursive: true,
          force: true,
        });
      throw new Error(
        "备份未完成，原始数据未改变；请检查磁盘空间、文件占用或目录链接",
      );
    } finally {
      this.busy = false;
    }
  }
  verify(id) {
    const folder = this.directory(id);
    let m;
    try {
      m = JSON.parse(
        fs.readFileSync(path.join(folder, "manifest.json"), "utf8"),
      );
    } catch {
      throw new Error("此旧备份没有校验清单，请打开目录手动检查");
    }
    if (m.version !== 1 || !Array.isArray(m.files) || !m.files.length)
      throw new Error("备份清单无效");
    for (const item of m.files) {
      const file = within(folder, item.path);
      if (
        !fs.existsSync(file) ||
        !fs.statSync(file).isFile() ||
        fs.statSync(file).size !== item.bytes ||
        hash(file) !== item.sha256
      )
        throw new Error("备份完整性校验失败，未执行恢复");
    }
    return { ok: true, files: m.files.length, manifest: m };
  }
  async restoreAccounts(id) {
    const { manifest } = this.verify(id),
      folder = this.directory(id);
    const docs = manifest.files
      .filter((f) => /^accounts\/[\w-]+\.info$/.test(f.path))
      .map((f) => JSON.parse(fs.readFileSync(within(folder, f.path), "utf8")));
    if (!docs.length) throw new Error("此备份不含账号快照");
    // Import validates identity, expiry and service access; backs up replaced snapshots.
    // Client logins and all live conversation databases remain untouched.
    await this.backend.native.importDocuments(docs);
    return { count: docs.length };
  }
}
module.exports = { BackupStore, within };
