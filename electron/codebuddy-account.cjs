const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { DatabaseSync } = require("node:sqlite");
const { atomicWrite } = require("./native-account.cjs");
const { validDocument } = require("./account-document.cjs");
const { CodebuddyCrypto } = require("./codebuddy-crypto.cjs");
const run = promisify(execFile);
const STORAGE_KEY =
  "secret://" +
  JSON.stringify({
    extensionId: "tencent-cloud.coding-copilot",
    key: "planning-genie.new.accessTokencn",
  });

class CodebuddyAccounts {
  constructor(backend, { crypto, processAction } = {}) {
    this.backend = backend;
    this.crypto = crypto || new CodebuddyCrypto(() => this.profile);
    this.profile = path.join(
      backend.home,
      "AppData",
      "Roaming",
      "CodeBuddy CN",
    );
    this.processAction = processAction || this.control.bind(this);
    this.busy = false;
    this.error = null;
    this.current = null;
  }
  get storage() {
    return path.join(this.profile, "User", "globalStorage", "state.vscdb");
  }
  requireCrypto() {
    if (!this.crypto?.isEncryptionAvailable())
      throw new Error("Windows 加密存储暂不可用，请通过本地控制台重试");
  }
  encryptedLogin() {
    if (!fs.existsSync(this.storage)) return null;
    const db = new DatabaseSync(this.storage, { readOnly: true });
    try {
      return (
        db.prepare("SELECT value FROM ItemTable WHERE key=?").get(STORAGE_KEY)
          ?.value ?? null
      );
    } finally {
      db.close();
    }
  }
  readCurrent() {
    const raw = this.encryptedLogin();
    if (raw == null) return null;
    this.requireCrypto();
    try {
      const serialized =
        typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
      const encrypted = JSON.parse(serialized);
      if (encrypted.type !== "Buffer" || !Array.isArray(encrypted.data))
        throw Error();
      const doc = JSON.parse(
        this.crypto.decryptString(Buffer.from(encrypted.data)),
      );
      if (!doc?.account?.uid || !doc.auth?.accessToken) return null;
      return doc;
    } catch {
      throw new Error("CodeBuddy 登录暂不可读取，请在客户端登录后重试");
    }
  }
  inspect() {
    try {
      this.current = this.readCurrent();
      this.error = null;
    } catch (e) {
      this.current = null;
      this.error = e.message;
    }
    return this.current;
  }
  summary() {
    return {
      uid: this.current?.account?.uid || null,
      name:
        typeof this.current?.account?.nickname === "string"
          ? this.current.account.nickname
          : null,
      error: this.error,
      configured: !!this.backend.settings.codebuddyExe,
      initialized: fs.existsSync(this.storage),
    };
  }
  async saveCurrent() {
    const current = this.readCurrent();
    if (!current) throw new Error("请先在 CodeBuddy CN 登录账号");
    const doc = await validDocument(this.backend, current);
    await this.backend.native.importDocuments(doc);
    return doc.account.uid;
  }
  async control(mode) {
    const exe = this.backend.settings.codebuddyExe;
    if (!exe || !fs.existsSync(exe))
      throw new Error("请在设置中选择 CodeBuddy CN.exe");
    const bundled =
      process.resourcesPath &&
      path.join(process.resourcesPath, "codebuddy-process.ps1");
    const script =
      bundled && fs.existsSync(bundled)
        ? bundled
        : path.join(__dirname, "..", "scripts", "codebuddy-process.ps1");
    try {
      const { stdout } = await run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          script,
          "-Exe",
          exe,
          "-Mode",
          mode,
        ],
        { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 },
      );
      return JSON.parse(stdout.trim());
    } catch {
      throw new Error(
        mode === "start"
          ? "CodeBuddy CN 启动失败，请检查程序路径"
          : "CodeBuddy CN 尚未退出，请先保存文件并正常退出后重试",
      );
    }
  }
  writeLogin(value) {
    const db = new DatabaseSync(this.storage);
    try {
      db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
      if (value == null)
        db.prepare("DELETE FROM ItemTable WHERE key=?").run(STORAGE_KEY);
      else
        db.prepare(
          "INSERT OR REPLACE INTO ItemTable(key,value) VALUES(?,?)",
        ).run(STORAGE_KEY, value);
      db.exec("COMMIT");
    } finally {
      db.close();
    }
  }
  async switchTo(uid) {
    if (this.busy) throw new Error("CodeBuddy CN 正在切换或重启");
    this.busy = true;
    let before,
      changed = false,
      stopped = false;
    try {
      if (!fs.existsSync(this.storage))
        throw new Error("请先启动一次 CodeBuddy CN 并登录，再使用切换功能");
      this.requireCrypto();
      const snapshot = this.backend.native.snapshot(uid);
      if (!snapshot) throw new Error("请先导入账号 JSON 或保存客户端登录");
      const target = await validDocument(this.backend, snapshot);
      const session = { ...target, id: "Tencent-Cloud.genie-ide-cn" };
      session.auth.domain = "copilot.tencent.com";
      session.account.lastLogin = true;
      session.auth.expiresIn = Math.floor(
        (session.auth.expiresAt - Date.now()) / 1000,
      );
      session.auth.lastRefreshTime = Date.now();
      if (session.auth.refreshToken.split(".").length === 3) {
        const refresh = JSON.parse(
          Buffer.from(
            session.auth.refreshToken.split(".")[1],
            "base64url",
          ).toString(),
        );
        session.auth.refreshExpiresAt = refresh.exp * 1000;
        session.auth.refreshExpiresIn = Math.floor(
          (refresh.exp * 1000 - Date.now()) / 1000,
        );
      }
      // Encrypt before stopping the client. Key material never leaves safeStorage.
      const encrypted = Buffer.from(
        JSON.stringify(this.crypto.encryptString(JSON.stringify(session))),
        "utf8",
      );
      if ((await this.processAction("status")).running) {
        await this.processAction("stop");
        stopped = true;
      }
      if ((await this.processAction("status")).running)
        throw new Error("CodeBuddy CN 尚未退出，未修改登录");
      before = this.encryptedLogin();
      const current = this.readCurrent();
      // Save the departing identity without ever changing WorkBuddy's login.
      if (current?.account?.uid && /^[\w-]{8,100}$/.test(current.account.uid)) {
        const decoded = await this.backend.decodeNative(current);
        if (decoded.access) this.backend.native.saveSnapshot(current);
      }
      await this.backend.backupStore.create("codebuddy", "switch");
      this.writeLogin(encrypted);
      changed = true;
      await this.processAction("start");
      if (this.readCurrent()?.account.uid !== uid)
        throw new Error("CodeBuddy CN 登录身份校验失败");
      return { ok: true, uid };
    } catch (e) {
      if (changed) {
        try {
          await this.processAction("stop");
          if ((await this.processAction("status")).running) throw Error();
          // Restore this one secret only; preserve settings, editors and conversations.
          this.writeLogin(before);
          await this.processAction("start");
        } catch {
          throw new Error(
            "CodeBuddy 切换失败且登录恢复未完成，请保留本地备份并手动恢复",
          );
        }
      } else if (stopped) {
        try {
          await this.processAction("start");
        } catch {}
      }
      throw e;
    } finally {
      this.busy = false;
      this.inspect();
    }
  }
  async restart() {
    if (this.busy) throw new Error("CodeBuddy CN 正在切换或重启");
    this.busy = true;
    try {
      if ((await this.processAction("status")).running)
        await this.processAction("stop");
      await this.processAction("start");
    } finally {
      this.busy = false;
    }
  }
}
module.exports = { CodebuddyAccounts, STORAGE_KEY };
