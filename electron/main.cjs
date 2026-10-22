const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  dialog,
  nativeTheme,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { Backend, safeError } = require("./backend.cjs");
const { DemoBackend } = require("./demo.cjs");
const { atomicWrite } = require("./native-account.cjs");
app.setName("WorkBuddy Switch");
app.setAppUserModelId("io.github.3160696.workbuddyswitch");
const demo = process.argv.includes("--demo");
let win, backend, refreshing;
const ownsLock = app.requestSingleInstanceLock();
if (!ownsLock) app.quit();
else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  app.whenReady().then(async () => {
    nativeTheme.themeSource = "light";
    backend = demo
      ? new DemoBackend({
          accountCount: process.argv.includes("--demo-four") ? 4 : 3,
        })
      : new Backend();
    win = new BrowserWindow({
      width: 1280,
      height: 860,
      minWidth: 960,
      minHeight: 640,
      title: "WorkBuddy Switch",
      backgroundColor: "#f7f8fa",
      icon: path.join(__dirname, "icon.png"),
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setMenu(null);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_w, _p, callback) =>
      callback(false),
    );
    const expose = (name, handler) =>
      ipcMain.handle(name, async (event, ...args) => {
        if (
          event.sender !== win.webContents ||
          event.senderFrame !== win.webContents.mainFrame
        )
          throw new Error("Invalid sender");
        try {
          return { ok: true, value: await handler(...args) };
        } catch (e) {
          return { ok: false, error: safeError(e) };
        }
      });
    const publish = (state) => {
      if (!win.isDestroyed()) win.webContents.send("hub:state", state);
      return state;
    };
    let mutating = false;
    const mutate =
      (handler) =>
      async (...args) => {
        if (mutating)
          throw new Error("另一项账号或备份操作正在进行，请稍后重试");
        mutating = true;
        try {
          return await handler(...args);
        } finally {
          mutating = false;
        }
      };
    expose("hub:load", async () => {
      await backend.discover();
      return backend.state();
    });
    expose("hub:refresh", async () => publish(await backend.refresh()));
    expose("hub:account-order", (uids) =>
      publish(backend.reorderAccounts(uids)),
    );
    expose("hub:model-tests-start", (items) =>
      backend.startModelTests(items, () => publish(backend.state())),
    );
    expose("hub:model-tests-cancel", () => {
      const job = backend.cancelModelTests();
      publish(backend.state());
      return job;
    });
    expose("hub:conversations", () => backend.conversations());
    expose("hub:usage", (start, end) => backend.usage(start, end));
    expose(
      "hub:usage-export",
      async (start, end, client = "all", uids = "all", search = "") => {
        if (demo) throw new Error("演示模式不导出真实账单");
        if (!["all", "WorkBuddy", "CodeBuddyIDE"].includes(client))
          throw Error("客户端无效");
        if (typeof search !== "string" || search.length > 200)
          throw Error("搜索条件无效");
        if (
          uids !== "all" &&
          (!Array.isArray(uids) ||
            uids.some((uid) => !backend.accounts.some((a) => a.uid === uid)))
        )
          throw Error("账号无效");
        const report = await backend.usage(start, end);
        const accounts = report.accounts.filter(
          (a) => uids === "all" || uids.includes(a.uid),
        );
        if (!accounts.length || accounts.some((a) => !a.complete))
          throw Error("所选账号的账单未全部查询成功，请重试后导出");
        const choice = await dialog.showSaveDialog(win, {
          title: "导出每日模型消费账单",
          defaultPath: `Buddy-账单-${start}-${end}.csv`,
          filters: [{ name: "CSV 表格", extensions: ["csv"] }],
        });
        if (choice.canceled) return { canceled: true };
        const { aggregate } = require("./usage-ledger.cjs");
        const csv = (v) =>
          '"' +
          String(v ?? "")
            .replace(/^[=+@-]/, "'$&")
            .replace(/"/g, '""') +
          '"';
        const rows = aggregate(accounts, client).filter((r) =>
          (r.model + " " + r.account)
            .toLowerCase()
            .includes(search.toLowerCase()),
        );
        const lines = [
          [
            "日期（北京时间）",
            "账号",
            "模型",
            "客户端",
            "账单条数",
            "消费积分",
            "缺失金额条数",
          ],
          ...rows.map((r) => [
            r.day,
            r.account,
            r.model,
            r.client,
            r.requests,
            r.credits,
            r.unknown,
          ]),
        ];
        atomicWrite(
          choice.filePath,
          "\uFEFF" + lines.map((r) => r.map(csv).join(",")).join("\r\n"),
        );
        return { count: rows.length };
      },
    );
    expose("hub:backups", () => backend.backups());
    expose(
      "hub:import",
      mutate(async () => {
        if (demo) throw new Error("演示模式不导入真实账号");
        const result = await dialog.showOpenDialog(win, {
          title: "导入 WorkBuddy / CodeBuddy 国内版账号 JSON",
          properties: ["openFile"],
          filters: [{ name: "JSON 账号文件", extensions: ["json"] }],
        });
        if (result.canceled) return { canceled: true };
        const file = result.filePaths[0];
        if (fs.statSync(file).size > 4 * 1024 * 1024)
          throw new Error("账号文件超过 4 MB，请检查文件");
        let raw;
        try {
          raw = JSON.parse(
            fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""),
          );
        } catch {
          throw new Error("文件不是有效的账号 JSON");
        }
        return { state: publish(await backend.importDocuments(raw)) };
      }),
    );
    expose(
      "hub:switch-desktop",
      mutate(async (uid, client) =>
        publish(await backend.switchDesktop(uid, client)),
      ),
    );
    expose(
      "hub:restart-desktop",
      mutate(async (client) => publish(await backend.restartDesktop(client))),
    );
    expose(
      "hub:save-desktop",
      mutate(async (client) => publish(await backend.saveDesktop(client))),
    );
    expose(
      "hub:export-accounts",
      mutate(async (uids) => {
        if (demo) throw new Error("演示模式不导出真实登录凭据");
        const choice = await dialog.showSaveDialog(win, {
          title: "导出有效账号 JSON（含完整登录凭据）",
          defaultPath:
            "Buddy-accounts-" + new Date().toISOString().slice(0, 10) + ".json",
          filters: [{ name: "JSON 账号文件", extensions: ["json"] }],
        });
        if (choice.canceled) return { canceled: true };
        if (path.extname(choice.filePath).toLowerCase() !== ".json")
          throw new Error("请保存为 .json 文件");
        const { documents, skipped } = await backend.exportAccounts(uids);
        atomicWrite(
          choice.filePath,
          JSON.stringify(uids === "all" ? documents : documents[0], null, 2),
        );
        return { count: documents.length, skipped };
      }),
    );
    expose(
      "hub:backup-create",
      mutate(async (client) => {
        if (demo) throw new Error("演示模式不备份真实数据");
        return backend.backupStore.create(client);
      }),
    );
    expose(
      "hub:backup-verify",
      mutate(async (id) => {
        if (demo) throw new Error("演示模式不读取真实备份");
        const result = backend.backupStore.verify(id);
        return { ok: result.ok, files: result.files };
      }),
    );
    expose("hub:backup-open", async (id) => {
      if (demo) throw new Error("演示模式不打开真实备份");
      const error = await shell.openPath(backend.backupStore.directory(id));
      if (error) throw new Error("无法打开备份目录");
    });
    expose(
      "hub:backup-restore",
      mutate(async (id) => {
        if (demo) throw new Error("演示模式不恢复真实数据");
        const result = await backend.backupStore.restoreAccounts(id);
        await backend.discover();
        return { ...result, state: publish(backend.state()) };
      }),
    );
    expose("hub:extras", (uid) => backend.extras(uid));
    expose("hub:action", (uid, action, arg) =>
      backend.action(uid, action, arg),
    );
    expose("hub:settings", () => backend.connectionSettings());
    expose("hub:choose-exe", async (key) => {
      if (demo) throw new Error("演示模式不修改本机设置");
      if (!["workbuddyExe", "codebuddyExe"].includes(key))
        throw new Error("未知程序");
      const result = await dialog.showOpenDialog(win, {
        title:
          key === "workbuddyExe"
            ? "选择官方 WorkBuddy.exe"
            : "选择官方 CodeBuddy CN.exe",
        properties: ["openFile"],
        filters: [{ name: "Windows 程序", extensions: ["exe"] }],
      });
      return result.canceled
        ? backend.connectionSettings()
        : backend.setExecutable(key, result.filePaths[0]);
    });
    expose("hub:open", async (name) => {
      if (demo) throw new Error("演示模式不打开本机目录或导出真实数据");
      if (name === "backups") {
        const folder = path.join(backend.dataDir, "backups");
        fs.mkdirSync(folder, { recursive: true });
        const error = await shell.openPath(folder);
        if (error) throw new Error("无法打开备份目录");
        return;
      }
      if (name === "report") {
        const choice = await dialog.showSaveDialog(win, {
          title: "导出积分与模型状态（不含登录凭据）",
          defaultPath: "WorkBuddy-积分概览.json",
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (!choice.canceled) {
          fs.writeFileSync(
            choice.filePath,
            JSON.stringify(backend.state(), null, 2),
          );
          return "报告已导出";
        }
        return "已取消";
      }
      throw new Error("未知入口");
    });
    await win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
    refreshing = setInterval(async () => {
      try {
        publish(await backend.refresh());
      } catch {
        /* Cached data remains visible. */
      }
    }, 180000);
  });
  app.on("window-all-closed", () => {
    backend?.cancelModelTests();
    clearInterval(refreshing);
    app.quit();
  });
}
