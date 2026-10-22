const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const D = require("./domain.cjs");
const { NativeAccounts } = require("./native-account.cjs");
const { readConversations, backupList } = require("./local-data.cjs");
const { CodebuddyAccounts } = require("./codebuddy-account.cjs");
const { BackupStore } = require("./backup-store.cjs");
const { validDocument } = require("./account-document.cjs");
const { UsageLedger, dailyUsage } = require("./usage-ledger.cjs");
const M = require("./model-status.cjs");
const {
  SOURCE: MANUAL_SOURCE,
  compareModels,
  testOfficial,
  ModelTests,
} = require("./model-test.cjs");
const PAID = [
  "TCACA_code_002_AkiJS3ZHF5",
  "TCACA_code_005_maRGyrHhw1",
  "TCACA_code_003_FAnt7lcmRT",
  "TCACA_code_023_4xbGhMrE6q",
  "TCACA_code_026_BaESVICNoi",
  "TCACA_code_027_0FCGVA6vSa",
  "TCACA_code_009_0XmEQc2xOf",
  "TCACA_code_038_OhvqZtiPKr",
  "TCACA_code_036_lupO5WgNdG",
];
const FREE = [
  "TCACA_code_001_PqouKr6QWV",
  "TCACA_code_008_cfWoLwvjU4",
  "TCACA_code_035_ArVxJcGDsm",
  "TCACA_code_006_DbXS0lrypC",
  "TCACA_code_039_KRcQj7wUat",
  "TCACA_code_040_mi9rCYg46x",
  "TCACA_code_007_nzdH5h4Nl0",
  "TCACA_code_028_NtpWi0jzXs",
  "TCACA_code_029_6wCGEWquYy",
  "TCACA_code_030_BjSt89qTvr",
  "TCACA_code_037_WxOD3MpI2o",
];
function readJSON(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}
function saveJSON(p, value) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const temp = p + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, p);
}
function safeError(e) {
  return String(e?.message || "请求失败")
    .replace(/Bearer\s+[^\s]+/gi, "[凭据已隐藏]")
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[凭据已隐藏]")
    .slice(0, 160);
}
class Backend {
  constructor({
    home = os.homedir(),
    dataDir,
    fetchImpl = fetch,
    crypto,
    codebuddyOptions,
  } = {}) {
    this.home = home;
    this.dataDir = dataDir || path.join(home, ".workbuddy-switch");
    this.accountAliases = readJSON(
      path.join(this.dataDir, "account-aliases.json"),
      {},
    );
    this.orderFile = path.join(this.dataDir, "account-order.json");
    const savedOrder = readJSON(this.orderFile, []);
    this.accountOrder = Array.isArray(savedOrder)
      ? savedOrder.filter((uid) => typeof uid === "string")
      : [];
    this.settingsFile = path.join(this.dataDir, "settings.json");
    this.settings = {
      workbuddyExe: readJSON(this.settingsFile, {}).workbuddyExe || "",
      codebuddyExe: readJSON(this.settingsFile, {}).codebuddyExe || "",
    };
    this.fetch = fetchImpl;
    this.vault = path.join(home, ".workbuddy-account-hub", "vault");
    this.nativeAuth = path.join(
      process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"),
      "CodeBuddyExtension",
      "Data",
      "Public",
      "auth",
      "workbuddy-desktop.info",
    );
    this.cacheFile = path.join(this.dataDir, "dashboard-cache.json");
    this.eventFile = path.join(this.dataDir, "model-observations.json");
    this.cache = readJSON(
      this.cacheFile,
      readJSON(
        path.join(
          home,
          ".workbuddy-account-hub",
          "light",
          "dashboard-cache.json",
        ),
        {},
      ),
    );
    this.events = readJSON(
      this.eventFile,
      readJSON(
        path.join(
          home,
          ".workbuddy-account-hub",
          "light",
          "model-observations.json",
        ),
        {},
      ),
    );
    this.accounts = [];
    this.credentials = new Map();
    this.decryptCache = new Map();
    this.refreshPromise = null;
    this.events = Object.fromEntries(
      Object.entries(this.events).filter(([, event]) =>
        ["WorkBuddy 本地记录", MANUAL_SOURCE].includes(event?.source),
      ),
    );
    this.native = new NativeAccounts(this);
    this.codebuddy = new CodebuddyAccounts(this, {
      crypto,
      ...codebuddyOptions,
    });
    this.backupStore = new BackupStore(this);
    this.ledger = new UsageLedger(this);
    this.localLimits = { errors: {}, at: null };
    this.modelTests = new ModelTests((item, signal) =>
      testOfficial(this, item, signal),
    );
  }
  wbExe() {
    return (
      this.settings.workbuddyExe ||
      readJSON(
        path.join(
          this.home,
          "apps",
          "WorkBuddy-Account-Hub",
          "hub_settings.json",
        ),
      )?.workbuddy_exe ||
      ""
    );
  }
  connectionSettings() {
    return {
      workbuddyExe: this.wbExe(),
      codebuddyExe: this.settings.codebuddyExe,
    };
  }
  setExecutable(key, value) {
    if (
      !["workbuddyExe", "codebuddyExe"].includes(key) ||
      !path.isAbsolute(value) ||
      !fs.existsSync(value) ||
      path.extname(value).toLowerCase() !== ".exe"
    )
      throw new Error("请选择有效的程序文件");
    const expected =
      key === "workbuddyExe" ? "WorkBuddy.exe" : "CodeBuddy CN.exe";
    if (path.basename(value).toLowerCase() !== expected.toLowerCase())
      throw new Error("请选择官方 " + expected);
    this.settings[key] = value;
    saveJSON(this.settingsFile, this.settings);
    return this.connectionSettings();
  }
  async decodeNative(doc, { refresh = false } = {}) {
    const fields = {
      access: doc?.auth?.accessToken,
      nickname: doc?.account?.nickname,
      ...(refresh ? { refresh: doc?.auth?.refreshToken } : {}),
    };
    const wrapped = Object.values(fields).some((v) => v?.$wbEncrypted);
    if (wrapped) {
      const exe = this.wbExe();
      if (!exe || !fs.existsSync(exe))
        throw new Error("请选择本机 WorkBuddy.exe，以解密已保存的登录");
      const key = JSON.stringify(fields);
      if (this.decryptCache.has(key)) return this.decryptCache.get(key);
      const worker = fs.readFileSync(
        path.join(__dirname, "decrypt-worker.cjs"),
        "utf8",
      );
      const output = await new Promise((resolve, reject) => {
        const cp = execFile(
          exe,
          ["-e", worker],
          {
            windowsHide: true,
            cwd: path.dirname(exe),
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
            timeout: 25000,
            maxBuffer: 1024 * 1024,
          },
          (err, stdout) =>
            err
              ? reject(
                  new Error("账号解密失败，请在官方 WorkBuddy 登录后重新保存"),
                )
              : resolve(stdout),
        );
        cp.stdin.end(JSON.stringify({ fields }));
      });
      let result;
      try {
        result = JSON.parse(output);
      } catch {
        throw new Error("旧账号解密失败");
      }
      if (!result.ok || !result.out?.access?.ok)
        throw new Error("旧账号解密失败");
      const decoded = {
        access: result.out.access.value,
        name: result.out.nickname?.value,
        ...(refresh
          ? {
              refresh: result.out.refresh?.ok ? result.out.refresh.value : null,
            }
          : {}),
      };
      this.decryptCache.set(key, decoded);
      return decoded;
    }
    return {
      access: typeof fields.access === "string" ? fields.access : null,
      name: typeof fields.nickname === "string" ? fields.nickname : null,
      ...(refresh
        ? {
            refresh: typeof fields.refresh === "string" ? fields.refresh : null,
          }
        : {}),
    };
  }
  async discover() {
    const found = new Map();
    // Publish credentials atomically: a background discovery must not remove
    // credentials from a manual batch while encrypted snapshots are decoded.
    const credentials = new Map();
    const add = (uid, name, source, extra = {}) => {
      if (typeof uid !== "string" || !/^[\w-]{8,100}$/.test(uid)) return;
      const old = found.get(uid) || {
        uid,
        name: name || this.cache[uid]?.name || uid.slice(0, 8),
        sources: [],
      };
      if (name && !name.startsWith("eyJ")) old.name = name;
      if (!old.sources.includes(source)) old.sources.push(source);
      Object.assign(old, extra);
      found.set(uid, old);
      return old;
    };
    for (const cached of Object.values(this.cache))
      if (cached?.uid) add(cached.uid, cached.name, "历史记录");
    const registry = path.join(this.home, ".workbuddy", "local_storage");
    if (fs.existsSync(registry))
      for (const file of fs
        .readdirSync(registry)
        .filter((f) => f.endsWith(".info"))) {
        const entries = readJSON(path.join(registry, file));
        if (Array.isArray(entries))
          for (const item of entries)
            add(
              item.userId,
              typeof item.data?.nickname === "string"
                ? item.data.nickname
                : null,
              "本地登记表",
            );
      }
    const native = readJSON(this.nativeAuth);
    for (const a of [
      ...(native?.allAccounts || []),
      ...(native?.accounts || []),
    ])
      add(
        a.uid,
        typeof a.nickname === "string" ? a.nickname : null,
        "WorkBuddy",
      );
    const docs = [];
    if (fs.existsSync(this.native.folder))
      for (const file of fs
        .readdirSync(this.native.folder)
        .filter((f) => f.endsWith(".info"))) {
        const doc = readJSON(path.join(this.native.folder, file));
        if (doc?.account?.uid) {
          add(doc.account.uid, null, "WorkBuddy 登录快照");
          docs.push({ doc, source: "WorkBuddy 登录快照" });
        }
      }
    if (native?.account?.uid)
      docs.push({ doc: native, source: "WorkBuddy", current: true });
    const codebuddy = this.codebuddy.inspect();
    if (codebuddy?.account?.uid)
      docs.push({ doc: codebuddy, source: "CodeBuddy CN" });
    if (fs.existsSync(this.vault))
      for (const uid of fs.readdirSync(this.vault)) {
        const doc = readJSON(
          path.join(this.vault, uid, "snapshot", "auth.info"),
        );
        if (doc?.account?.uid === uid && doc.auth?.accessToken) {
          add(uid, null, "已保存快照");
          docs.push({ doc, source: "已保存快照" });
        }
      }
    docs.sort((a, b) => Number(!!b.current) - Number(!!a.current));
    for (const { doc, source, current } of docs) {
      const uid = doc.account.uid,
        a = add(uid, null, source, current ? { desktopActive: true } : {});
      if (!a) continue;
      if (credentials.has(uid)) continue;
      try {
        const decoded = await this.decodeNative(doc);
        if (decoded.name) a.name = decoded.name;
        if (decoded.access)
          credentials.set(uid, {
            uid,
            access: decoded.access,
            domain: doc.auth?.domain,
            origin: "snapshot",
          });
      } catch (e) {
        a.authError = safeError(e);
      }
    }
    this.credentials = credentials;
    this.accounts = [...found.values()]
      .map((a) => ({
        ...a,
        hasCredential: this.credentials.has(a.uid),
        canSwitchDesktop: !!this.native.snapshot(a.uid),
        codebuddyActive: a.uid === codebuddy?.account?.uid,
        canSwitchCodebuddy: !!this.native.snapshot(a.uid),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    return this.accounts;
  }
  headers(auth) {
    return {
      Authorization: "Bearer " + auth.access,
      "X-User-Id": auth.uid,
      "X-Domain": auth.domain || "www.codebuddy.cn",
      "X-IDE-Type": "WorkBuddy",
      "X-IDE-Name": "WorkBuddy",
      "X-IDE-Version": "5.8.3",
      "X-Agent-Intent": "craft",
      "X-Agent-Purpose": "conversation",
      "X-Product": "SaaS",
      "X-Requested-With": "XMLHttpRequest",
      "User-Agent": "CLI/2.0.0 WorkBuddy/5.8.3",
      "Content-Type": "application/json",
      ...(auth.enterpriseId
        ? {
            "X-Enterprise-Id": auth.enterpriseId,
            "X-Tenant-Id": auth.enterpriseId,
          }
        : {}),
    };
  }
  async api(uid, endpoint, body) {
    const auth = this.credential(uid);
    if (!auth?.access)
      throw new Error("请在官方 WorkBuddy 登录该账号并保存，或导入账号 JSON");
    let response;
    try {
      response = await this.fetch("https://copilot.tencent.com" + endpoint, {
        method: body === undefined ? "GET" : "POST",
        headers: this.headers(auth),
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(18000),
      });
    } catch {
      throw new Error("连接官方服务失败，请稍后刷新");
    }
    if (response.status === 401 || response.status === 403)
      throw new Error("登录已失效或权限不足，请更新该账号的官方客户端登录");
    if (!response.ok) throw new Error("官方服务 HTTP " + response.status);
    let env;
    try {
      env = await response.json();
    } catch {
      throw new Error("官方接口返回格式错误");
    }
    if (env.code !== 0 && env.code !== "0")
      throw new Error(
        "官方接口未成功（代码 " +
          String(env.code).slice(0, 20) +
          "），请刷新或更新登录",
      );
    if (env.data == null) throw new Error("官方接口未返回数据");
    return env.data;
  }
  credential(uid) {
    return this.credentials.get(uid);
  }
  async packagePages(uid, kind) {
    const rows = [],
      day = D.todayShanghai();
    for (let page = 1; page <= 100; page++) {
      const data = await this.api(
        uid,
        "/billing/meter/get-user-resource-" + kind + "-packages",
        {
          PageNumber: page,
          PageSize: 100,
          PackageCodes: kind === "paid" ? PAID : FREE,
          Status: [0, 3],
          IsDisplayTotalInfo: true,
          ...(kind === "paid"
            ? { NeedRenewInfo: true }
            : {
                SlicePeriodStartTime: day + " 00:00:00",
                SlicePeriodEndTime: day + " 23:59:59",
              }),
        },
      );
      if (!Array.isArray(data.Accounts))
        throw new Error("积分包列表格式已变化");
      rows.push(...data.Accounts);
      if (
        data.Accounts.length < 100 ||
        (Number(data.TotalCount) > 0 && rows.length >= Number(data.TotalCount))
      )
        return rows;
    }
    throw new Error("积分包数量超出查询上限，明细不完整");
  }
  async refreshAccount(account) {
    const uid = account.uid,
      old = this.cache[uid] || {},
      day = D.todayShanghai();
    const results = await Promise.allSettled([
      this.api(uid, "/billing/meter/get-user-resource-summary", {}).then(
        D.balance,
      ),
      Promise.all([
        this.packagePages(uid, "paid"),
        this.packagePages(uid, "free"),
      ]).then(([a, b]) => D.packages([...a, ...b])),
      this.api(uid, "/v3/config").then(M.catalog),
      this.api(uid, "/billing/meter/checkin-activity-status", {}),
      this.ledger
        .account(account, { start: day, end: day })
        .then((report) => dailyUsage(report, day)),
    ]);
    const record = {
      uid,
      name: account.name,
      ...Object.fromEntries(
        [
          "balance",
          "packages",
          "models",
          "checkin",
          "todayUsage",
          "busyLevels",
          "busyAt",
          "balanceAt",
          "packagesAt",
          "modelsAt",
          "checkinAt",
        ]
          .filter((k) => old[k] !== undefined)
          .map((k) => [k, old[k]]),
      ),
      errors: {},
      attemptedAt: Date.now(),
    };
    for (let i = 0; i < results.length; i++) {
      const key = ["balance", "packages", "models", "checkin", "todayUsage"][i],
        r = results[i];
      if (r.status === "fulfilled") {
        record[key] = r.value;
        record[key + "At"] = Date.now();
        if (key === "todayUsage" && r.value.error)
          record.errors.todayUsage = r.value.error;
      } else record.errors[key] = safeError(r.reason);
    }
    if (record.models?.length) {
      try {
        const data = await this.api(uid, "/v2/chat/busy", {
          models: record.models.map((m) => m.id),
        });
        if (!Array.isArray(data)) throw Error("官方模型状态格式已变化");
        const valid = new Set([
          "idle",
          "normal",
          "busy",
          "congested",
          "unavailable",
          "unknown",
        ]);
        record.busyLevels = Object.fromEntries(
          data
            .filter(
              (r) =>
                record.models.some((m) => m.id === r.model) &&
                valid.has(r.busy_level),
            )
            .map((r) => [r.model, r.busy_level]),
        );
        record.busyAt = Date.now();
      } catch (e) {
        record.errors.busy = safeError(e);
      }
    }
    this.cache[uid] = record;
    return record;
  }
  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      await this.discover();
      // A small worker pool keeps all accounts visible without flooding the API.
      const queue = [...this.accounts];
      await Promise.all(
        [0, 1].map(async () => {
          while (queue.length) await this.refreshAccount(queue.shift());
        }),
      );
      this.readDesktopLimits();
      saveJSON(this.eventFile, this.events);
      saveJSON(this.cacheFile, this.cache);
      return this.state();
    })().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }
  readDesktopLimits() {
    this.localLimits = M.readCaps(this.home, this.accounts);
    for (const event of this.localLimits.events) {
      const id = event.uid + "/" + event.model;
      if (!this.events[id] || this.events[id].at < event.at)
        this.events[id] = event;
    }
  }
  startModelTests(items, changed) {
    if (!Array.isArray(items) || !items.length || items.length > 500)
      throw Error("请选择要手动测试的模型（最多 500 项）");
    const seen = new Set();
    const tasks = items
      .map((item) => {
        const uid = item?.uid,
          model = item?.model;
        if (
          typeof uid !== "string" ||
          typeof model !== "string" ||
          !this.accounts.some((a) => a.uid === uid) ||
          !this.cache[uid]?.models?.some((m) => m.id === model)
        )
          throw Error("模型不在该账号的官方目录中，请先刷新数据");
        if (!this.credential(uid)?.access)
          throw Error("该账号缺少登录，请重新导入 JSON");
        const key = uid + "/" + model;
        if (seen.has(key)) throw Error("测试列表中有重复的账号 / 模型");
        seen.add(key);
        return { uid, model };
      })
      .sort((a, b) =>
        compareModels({ ...a, id: a.model }, { ...b, id: b.model }),
      );
    return this.modelTests.start(
      tasks,
      (result) => {
        this.events[result.uid + "/" + result.model] = result;
        saveJSON(this.eventFile, this.events);
      },
      changed,
    );
  }
  cancelModelTests() {
    return this.modelTests.cancel();
  }
  reorderAccounts(uids) {
    if (
      !Array.isArray(uids) ||
      uids.length !== this.accounts.length ||
      new Set(uids).size !== uids.length ||
      uids.some((uid) => !this.accounts.some((a) => a.uid === uid))
    )
      throw Error("账号列表已变化，请刷新后重新排序");
    saveJSON(this.orderFile, uids);
    this.accountOrder = [...uids];
    return this.state();
  }
  state() {
    const now = Date.now();
    const positions = new Map(this.accountOrder.map((uid, i) => [uid, i]));
    const ordered = [...this.accounts].sort(
      (a, b) =>
        (positions.get(a.uid) ?? Infinity) - (positions.get(b.uid) ?? Infinity),
    );
    return {
      accounts: ordered.map((a) => {
        const c = this.cache[a.uid] || {};
        const models = [...(c.models || [])];
        for (const e of Object.values(this.events))
          if (e.uid === a.uid && !models.some((m) => m.id === e.model))
            models.push({ id: e.model, name: e.model });
        return {
          ...a,
          ...c,
          name: this.accountName(a),
          todayUsage:
            c.todayUsage?.day === D.todayShanghai(now) ? c.todayUsage : null,
          packages: c.packages || [],
          expiry: D.expirySummary(c.packages || [], now),
          models: models.sort(compareModels).map((m) => {
            const event = this.events[a.uid + "/" + m.id];
            return {
              ...m,
              event,
              state: D.modelState(event, now),
              busy: c.busyLevels?.[m.id] || "unknown",
              canTest:
                !!a.hasCredential &&
                !!c.models?.some((known) => known.id === m.id),
            };
          }),
          limitsAt: this.localLimits.at,
          limitsError: this.localLimits.errors[a.uid],
        };
      }),
      desktop: this.desktopSummary(),
      codebuddy: this.codebuddy.summary(),
      modelTests: this.modelTests.state(),
      now,
      refreshing: false,
    };
  }
  desktopSummary() {
    const current = readJSON(this.nativeAuth)?.account?.uid || null;
    try {
      const local = readConversations(this.home);
      const backups = backupList(this.dataDir);
      return {
        uid: current,
        visible: local.rows.filter((r) => r.uid === current).length,
        total: local.rows.length,
        activeTasks: local.rows.filter((r) =>
          ["working", "running", "processing"].includes(r.status),
        ).length,
        backup: backups.find((b) => b.database && b.login) || null,
      };
    } catch {
      return {
        uid: current,
        visible: null,
        total: null,
        activeTasks: null,
        error: "暂时无法读取对话数据库",
      };
    }
  }
  conversations() {
    return readConversations(this.home);
  }
  accountName(account) {
    const name = account.name || account.uid?.slice(0, 8) || "未命名账号";
    const alias = this.accountAliases?.[account.uid];
    return typeof alias === "string" && /^[\w-]{1,32}$/.test(alias)
      ? `${name} · ${alias}`
      : name;
  }
  async usage(start, end) {
    const report = await this.ledger.query(start, end);
    return {
      ...report,
      accounts: report.accounts.map((a) => ({
        ...a,
        name: this.accountName(a),
      })),
      summary: report.summary.map((r) => ({
        ...r,
        account: this.accountName({ uid: r.uid, name: r.account }),
      })),
    };
  }
  backups() {
    return this.backupStore.list();
  }
  async exportAccounts(uids) {
    await this.discover();
    const ids = uids === "all" ? this.accounts.map((a) => a.uid) : uids;
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 100 ||
      new Set(ids).size !== ids.length
    )
      throw new Error("请选择要导出的账号");
    const documents = [],
      skipped = [];
    for (const uid of ids) {
      const account = this.accounts.find((a) => a.uid === uid);
      if (!account) throw new Error("账号不存在");
      try {
        const doc = account.desktopActive
          ? readJSON(this.nativeAuth)
          : account.codebuddyActive
            ? this.codebuddy.readCurrent()
            : this.native.snapshot(uid);
        documents.push(await validDocument(this, doc));
      } catch (e) {
        if (uids !== "all") throw new Error(safeError(e));
        skipped.push({ name: account.name, reason: safeError(e) });
      }
    }
    if (!documents.length)
      throw new Error("没有验证有效的完整账号，请更新登录后再导出");
    return { documents, skipped };
  }
  async importDocuments(documents) {
    await this.native.importDocuments(documents);
    await this.discover();
    return this.state();
  }
  async switchDesktop(uid, client = "workbuddy") {
    await this.client(client).switchTo(uid);
    await this.discover();
    return this.state();
  }
  client(client) {
    if (client === "workbuddy") return this.native;
    if (client === "codebuddy") return this.codebuddy;
    throw new Error("未知客户端");
  }
  async restartDesktop(client = "workbuddy") {
    await this.client(client).restart();
    await this.discover();
    return this.state();
  }
  async saveDesktop(client = "workbuddy") {
    await this.client(client).saveCurrent();
    await this.discover();
    return this.state();
  }
  async extras(uid) {
    const requests = {
      checkin: ["/billing/meter/checkin-activity-status", {}],
      travel: ["/activity/growth/buddy/travel/status"],
      destinations: ["/activity/growth/buddy/travel/config"],
      energy: ["/activity/growth/energy"],
      memory: ["/api/memory/profile"],
    };
    const output = {};
    await Promise.all(
      Object.entries(requests).map(async ([key, args]) => {
        try {
          output[key] = await this.api(uid, ...args);
        } catch (e) {
          output[key] = { error: safeError(e) };
        }
      }),
    );
    // No raw auth, account object, or server debug response is exposed through IPC.
    return output;
  }
  async action(uid, action, arg) {
    if (!this.accounts.some((a) => a.uid === uid))
      throw new Error("账号不存在");
    const endpoints = {
      checkin: "/v2/billing/meter/daily-checkin",
      claim: "/activity/growth/buddy/travel/claim",
      depart: "/activity/growth/buddy/travel/depart",
      draw: "/activity/growth/buddy/open",
    };
    if (!endpoints[action]) throw new Error("操作不支持");
    if (action === "checkin") {
      const before = await this.api(
        uid,
        "/billing/meter/checkin-activity-status",
        {},
      );
      if (before.today_checked_in === true)
        return {
          ok: true,
          already: true,
          credits: D.number(before.today_credit),
        };
      if (before.active !== true) throw Error("官方签到活动当前未开放");
    }
    if (action === "depart" && (!Number.isSafeInteger(arg) || arg < 0))
      throw new Error("请选择有效目的地");
    await this.api(
      uid,
      endpoints[action],
      action === "depart"
        ? { location_id: arg }
        : action === "draw"
          ? { count: 1 }
          : {},
    );
    if (action === "checkin") {
      const after = await this.api(
        uid,
        "/billing/meter/checkin-activity-status",
        {},
      );
      if (after.today_checked_in !== true)
        throw Error("已提交签到，但官方尚未确认到账，请重新查询");
      return {
        ok: true,
        already: false,
        credits: D.number(after.today_credit),
      };
    }
    return { ok: true };
  }
}
module.exports = { Backend, readJSON, saveJSON, safeError };
