const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const {
  transferConversations,
  rollbackConversations,
} = require("./conversation-transfer.cjs");

function identityOf(token, uid, now = Date.now()) {
  let claims;
  try {
    claims = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString(),
    );
  } catch {
    throw new Error("WorkBuddy 登录信息无法校验，请重新保存该账号登录");
  }
  if (claims.sub !== uid)
    throw new Error("登录凭据与所选账号不一致，已停止切换");
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now)
    throw new Error("WorkBuddy 登录已过期，请在客户端重新登录并保存");
  return claims;
}
function mergeIdentity(current, target, uid) {
  if (target?.account?.uid !== uid || !target.auth?.accessToken)
    throw new Error("目标登录快照不完整");
  const accounts = new Map();
  for (const doc of [current, target])
    for (const a of [
      ...(doc?.allAccounts || []),
      ...(doc?.accounts || []),
      ...(doc?.account ? [doc.account] : []),
    ])
      if (a?.uid) accounts.set(a.uid, a);
  return {
    ...target,
    account: target.account,
    accounts: [target.account],
    allAccounts: [...accounts.values()],
  };
}
function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".switch-" + require("node:crypto").randomUUID() + ".tmp";
  try {
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
class NativeAccounts {
  constructor(backend, { processAction, activityCheck } = {}) {
    this.backend = backend;
    this.folder = path.join(backend.dataDir, "accounts");
    this.busy = false;
    this.processAction = processAction || this.control.bind(this);
    this.activityCheck = activityCheck || this.assertIdle.bind(this);
  }
  read(file) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    } catch {
      return null;
    }
  }
  snapshot(uid) {
    if (!/^[\w-]{8,100}$/.test(uid)) throw new Error("账号标识无效");
    return (
      this.read(path.join(this.folder, uid + ".info")) ||
      this.read(path.join(this.backend.vault, uid, "snapshot", "auth.info"))
    );
  }
  async saveCurrent() {
    const doc = this.read(this.backend.nativeAuth),
      uid = doc?.account?.uid;
    if (!uid || !/^[\w-]{8,100}$/.test(uid) || !doc.auth?.accessToken)
      throw new Error("请先在 WorkBuddy 客户端登录账号");
    this.saveSnapshot(doc);
    return uid;
  }
  saveSnapshot(doc) {
    const uid = doc?.account?.uid;
    if (
      typeof uid !== "string" ||
      !/^[\w-]{8,100}$/.test(uid) ||
      !doc.auth?.accessToken
    )
      throw new Error("账号快照不完整");
    const file = path.join(this.folder, uid + ".info"),
      bytes = JSON.stringify(doc, null, 2);
    if (fs.existsSync(file) && fs.readFileSync(file, "utf8") !== bytes)
      atomicWrite(
        path.join(
          this.backend.dataDir,
          "import-backups",
          require("node:crypto").randomUUID(),
          uid + ".info",
        ),
        fs.readFileSync(file),
      );
    atomicWrite(file, bytes);
  }
  async importDocuments(raw) {
    if (this.busy) throw new Error("请等待当前切换完成后再导入");
    this.busy = true;
    try {
      const rows = Array.isArray(raw) ? raw : [raw];
      if (!rows.length || rows.length > 100)
        throw new Error("一次可导入 1 到 100 个账号");
      const documents = [];
      const seen = new Set();
      for (const row of rows) {
        if (!row || typeof row !== "object")
          throw new Error("账号 JSON 格式无效");
        const uid = row.account?.uid || row.uid;
        if (
          typeof uid !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            uid,
          )
        )
          throw new Error("账号 UID 格式无效");
        if (seen.has(uid))
          throw new Error("JSON 中有重复账号，请保留每个账号的最新条目");
        seen.add(uid);
        let doc;
        if (row.account && row.auth) doc = structuredClone(row);
        else
          doc = {
            account: {
              uid,
              nickname: row.nickname || row.email || uid.slice(0, 8),
              type: "personal",
              pluginEnabled: true,
            },
            auth: {
              accessToken: row.access_token,
              refreshToken: row.refresh_token,
            },
          };
        const decoded = await this.backend.decodeNative(doc);
        const claims = identityOf(decoded.access, uid);
        const allowed = [
          "https://copilot.tencent.com/auth/realms/copilot",
          "https://www.codebuddy.cn/auth/realms/copilot",
          "https://www.workbuddy.cn/auth/realms/copilot",
        ];
        if (!allowed.includes(claims.iss))
          throw new Error("仅支持国内版 WorkBuddy 账号");
        if (!doc.auth.refreshToken)
          throw new Error("JSON 缺少刷新凭据，请导入完整账号文件");
        const response = await this.backend.fetch(
          "https://copilot.tencent.com/billing/meter/get-user-resource-summary",
          {
            method: "POST",
            headers: this.backend.headers({
              uid,
              access: decoded.access,
              domain: doc.auth.domain,
            }),
            body: "{}",
            redirect: "error",
            signal: AbortSignal.timeout(18000),
          },
        );
        const result = await response.json();
        if (!response.ok || Number(result.code) !== 0)
          throw new Error("账号验证失败，请更新登录后再导入");
        doc.auth = {
          ...doc.auth,
          tokenType: "Bearer",
          expiresAt: claims.exp * 1000,
          domain:
            doc.auth.domain ||
            (claims.iss.includes("codebuddy.cn")
              ? "www.codebuddy.cn"
              : "www.workbuddy.cn"),
        };
        doc.accounts = [doc.account];
        doc.allAccounts = [doc.account];
        documents.push(doc);
      }
      // Validate the entire file before writing any new account.
      for (const doc of documents) {
        const file = path.join(this.folder, doc.account.uid + ".info");
        if (fs.existsSync(file)) {
          const backup = path.join(
            this.backend.dataDir,
            "import-backups",
            require("node:crypto").randomUUID(),
            doc.account.uid + ".info",
          );
          atomicWrite(backup, fs.readFileSync(file));
        }
        atomicWrite(file, JSON.stringify(doc, null, 2));
      }
      return documents.length;
    } finally {
      this.busy = false;
    }
  }
  async control(mode) {
    const exe = this.backend.wbExe();
    if (!exe || !fs.existsSync(exe))
      throw new Error("请在连接设置中选择 WorkBuddy.exe");
    const bundled =
      process.resourcesPath &&
      path.join(process.resourcesPath, "workbuddy-process.ps1");
    const script =
      bundled && fs.existsSync(bundled)
        ? bundled
        : path.join(__dirname, "..", "scripts", "workbuddy-process.ps1");
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
          ? "WorkBuddy 未能启动，请检查程序路径"
          : "WorkBuddy 进程操作失败，请关闭客户端后重试",
      );
    }
  }
  assertIdle() {
    const file = path.join(this.backend.home, ".workbuddy", "workbuddy.db");
    if (!fs.existsSync(file)) return;
    let db;
    try {
      const { DatabaseSync } = require("node:sqlite");
      db = new DatabaseSync(file, { readOnly: true });
      const active = db
        .prepare(
          "SELECT COUNT(*) AS n FROM sessions WHERE status IN ('working','running','processing') AND deleted_at IS NULL",
        )
        .get();
      if (active.n > 0)
        throw new Error(
          "WorkBuddy 还有任务正在执行，请先完成或停止任务，再切号或重启",
        );
    } catch (e) {
      if (e.message.startsWith("WorkBuddy 还有任务")) throw e;
      throw new Error(
        "暂时无法确认 WorkBuddy 任务状态，请先手动退出客户端再切换",
      );
    } finally {
      db?.close();
    }
  }
  async restart() {
    if (this.busy) throw new Error("WorkBuddy 正在切换或重启");
    this.busy = true;
    try {
      if ((await this.processAction("status")).running) {
        await this.activityCheck();
        await this.processAction("stop");
      }
      await this.processAction("start");
      return { ok: true };
    } finally {
      this.busy = false;
    }
  }
  async switchTo(uid) {
    if (this.busy) throw new Error("WorkBuddy 正在切换或重启");
    this.busy = true;
    let before,
      conversationJournal,
      changed = false,
      stopped = false;
    try {
      const existing = this.read(this.backend.nativeAuth);
      if (!existing?.account?.uid || !existing.auth?.accessToken)
        throw new Error("请先在 WorkBuddy 客户端登录，再保存当前登录");
      const target = this.snapshot(uid);
      if (!target)
        throw new Error(
          "该账号尚无 WorkBuddy 登录快照，请先在客户端登录并点击保存登录",
        );
      mergeIdentity(existing, target, uid);
      const decoded = await this.backend.decodeNative(target);
      identityOf(decoded.access, uid);
      // Validate the saved official desktop identity before changing the login.
      const response = await this.backend.fetch(
        "https://copilot.tencent.com/billing/meter/get-user-resource-summary",
        {
          method: "POST",
          headers: this.backend.headers({
            uid,
            access: decoded.access,
            domain: target.auth.domain,
          }),
          body: "{}",
          redirect: "error",
          signal: AbortSignal.timeout(18000),
        },
      );
      const env = await response.json();
      if (!response.ok || Number(env.code) !== 0)
        throw new Error("目标 WorkBuddy 登录已失效，请在客户端重新登录并保存");
      if ((await this.processAction("status")).running) {
        await this.activityCheck();
        await this.processAction("stop");
        stopped = true;
      }
      before = fs.readFileSync(this.backend.nativeAuth, "utf8");
      const current = JSON.parse(before);
      await this.saveCurrent();
      const next = mergeIdentity(current, target, uid);
      const backup = path.join(
        this.backend.dataDir,
        "backups",
        new Date().toISOString().replace(/[:.]/g, "-"),
        "auth.info",
      );
      atomicWrite(backup, before);
      conversationJournal = transferConversations(
        this.backend.home,
        current.account.uid,
        uid,
        path.dirname(backup),
      );
      atomicWrite(this.backend.nativeAuth, JSON.stringify(next, null, 2));
      changed = true;
      await this.processAction("start");
      if (this.read(this.backend.nativeAuth)?.account?.uid !== uid)
        throw new Error("客户端登录身份校验失败");
      return { ok: true, uid };
    } catch (e) {
      if ((changed || conversationJournal) && before) {
        try {
          await this.processAction("stop");
          rollbackConversations(this.backend.home, conversationJournal);
          atomicWrite(this.backend.nativeAuth, before);
          await this.processAction("start");
        } catch {
          throw new Error(
            "切换失败且自动恢复未完成，请使用本地 backups 中的登录及对话备份恢复",
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
    }
  }
}
module.exports = { NativeAccounts, identityOf, mergeIdentity, atomicWrite };
