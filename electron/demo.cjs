// Entirely synthetic data for public screenshots and UI tests. No local files,
// credentials or network requests are read in this mode.
const D = require("./domain.cjs");
const { SOURCE, ModelTests } = require("./model-test.cjs");
class DemoBackend {
  constructor({ accountCount = 3 } = {}) {
    const now = Date.now();
    const modelIds = [
      "deepseek-v4.1-flash",
      "deepseek-v4-pro",
      "glm-5.3",
      "kimi-k3-1",
    ];
    this.accounts = ["个人账号", "工作账号", "备用账号", "演示账号"]
      .slice(0, accountCount === 4 ? 4 : 3)
      .map((name, i) => ({
        uid: `demo-account-${i}`,
        name: `${name} · buddy${i + 1}`,
        canSwitchDesktop: true,
        desktopActive: i === 1,
        codebuddyActive: i === 0,
        canSwitchCodebuddy: true,
        hasCredential: true,
        sources: ["演示数据"],
        balance: {
          remaining: [1842.83, 2469.13, 2080.44, 2356.12][i],
          total: [2000, 2600, 2500, 3000][i],
          used:
            [2000, 2600, 2500, 3000][i] -
            [1842.83, 2469.13, 2080.44, 2356.12][i],
          plan: "体验版",
        },
        balanceAt: now,
        todayUsage: {
          day: D.todayShanghai(now),
          credits: 36 + i * 2,
          knownCredits: 36 + i * 2,
          unknown: 0,
          requests: 3,
          complete: true,
          at: now,
          error: null,
        },
        packagesAt: now,
        modelsAt: now,
        busyAt: now,
        checkin: {
          active: true,
          today_checked_in: i !== 0,
          today_credit: i === 0 ? 0 : 100,
          streak_days: i + 1,
        },
        errors: {},
        packages: [
          {
            id: `demo-grant-${i}`,
            name: "活动奖励",
            originalName: "活动奖励积分",
            remaining: [342.83, 369.13, 80.44, 356.12][i],
            total: 500,
            start: now - 10 * D.DAY,
            end: now + [21, 2, 12, 18][i] * 3600000,
            state: "active",
          },
          {
            id: `demo-plan-${i}`,
            name: "套餐积分",
            remaining: [1500, 2100, 2000, 2000][i],
            total: [1500, 2100, 2000, 2000][i],
            end: now + 30 * D.DAY,
            start: now,
            state: "active",
          },
        ],
        models: modelIds.map((id, j) => {
          const event =
            j === 0 && i === 1
              ? {
                  uid: `demo-account-${i}`,
                  model: id,
                  status: 429,
                  at: now - 18 * 60000,
                  resetAt: now + 2 * 3600000 + 4 * 60000,
                  source: "官方限流提示 · 演示",
                }
              : j === 1
                ? {
                    status: 200,
                    at: now - 5 * 60000,
                    source: "WorkBuddy 本地记录",
                  }
                : null;
          return {
            id,
            name: id,
            event,
            state: D.modelState(event, now),
            busy: j === 2 ? "busy" : "idle",
            credits: "x0.11",
            canTest: true,
          };
        }),
      }));
    this.modelTests = new ModelTests(async (item, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (signal.aborted) return null;
      const limited =
        item.uid === "demo-account-1" && item.model === "deepseek-v4.1-flash";
      return {
        ...item,
        source: SOURCE,
        at: Date.now(),
        elapsedMs: 150,
        status: limited ? 429 : 200,
        httpStatus: limited ? 429 : 200,
        message: limited
          ? "您的使用量已超出频率限制，将在 2026-10-22 12:49:03 UTC+8 重置（演示）"
          : "官方已返回模型内容（演示）",
        resetAt: limited ? D.resetAt("2026-10-22 12:49:03 UTC+8") : null,
        reply: limited ? "" : "OK（演示回复）",
      };
    });
  }
  async discover() {
    return this.accounts;
  }
  state() {
    return {
      accounts: this.accounts.map((a) => ({
        ...a,
        expiry: D.expirySummary(a.packages),
      })),
      desktop: {
        uid: "demo-account-1",
        visible: 16,
        total: 16,
        backup: { at: Date.now(), database: true, login: true },
      },
      codebuddy: {
        uid: "demo-account-0",
        name: "个人账号",
        configured: true,
        initialized: true,
      },
      now: Date.now(),
      demo: true,
      modelTests: this.modelTests.state(),
    };
  }
  async refresh() {
    return this.state();
  }
  reorderAccounts(uids) {
    if (
      !Array.isArray(uids) ||
      uids.length !== this.accounts.length ||
      new Set(uids).size !== uids.length ||
      uids.some((uid) => !this.accounts.some((a) => a.uid === uid))
    )
      throw Error("账号列表已变化，请刷新后重新排序");
    this.accounts = uids.map((uid) => this.accounts.find((a) => a.uid === uid));
    return this.state();
  }
  startModelTests(items, changed) {
    return this.modelTests.start(
      items,
      (event) => {
        const m = this.accounts
          .find((a) => a.uid === event.uid)
          ?.models.find((m) => m.id === event.model);
        if (!m) throw Error("演示模型不存在");
        m.event = event;
        m.state = D.modelState(event);
      },
      changed,
    );
  }
  cancelModelTests() {
    return this.modelTests.cancel();
  }
  async switchDesktop() {
    throw new Error("演示模式不切换真实账号");
  }
  async restartDesktop() {
    throw new Error("演示模式不重启客户端");
  }
  async saveDesktop() {
    throw new Error("演示模式不保存本机登录");
  }
  async action() {
    throw new Error("演示模式不执行账号操作");
  }
  async extras() {
    return {
      checkin: {
        active: true,
        today_checked_in: true,
        today_credit: 100,
        streak_days: 2,
      },
      travel: { state: "traveling", arrive_at: Date.now() / 1000 + 3600 },
      energy: { balance: 20 },
      memory: { summary: "演示账号，无真实个人资料。" },
    };
  }
  async usage(start, end) {
    const { rangeOf, aggregate } = require("./usage-ledger.cjs");
    const range = rangeOf(start, end);
    const accounts = this.accounts.map((a, i) => ({
      uid: a.uid,
      name: a.name,
      complete: true,
      at: Date.now(),
      total: 3,
      rows: [
        {
          id: `demo-${i}-1`,
          day: end,
          at: D.shanghaiTime(end + " 10:00:00"),
          model: "deepseek-v4.1-flash",
          client: "WorkBuddy",
          credits: 12.35 + i,
        },
        {
          id: `demo-${i}-2`,
          day: end,
          at: D.shanghaiTime(end + " 10:10:00"),
          model: "glm-5.3",
          client: "WorkBuddy",
          credits: 21.8 + i,
        },
        {
          id: `demo-${i}-3`,
          day: start,
          at: D.shanghaiTime(start + " 12:00:00"),
          model: "mimo-v2.6-pro",
          client: "CodeBuddyIDE",
          credits: 1.85,
        },
      ],
    }));
    return { range, accounts, summary: aggregate(accounts), at: Date.now() };
  }
  conversations() {
    return {
      total: 3,
      deleted: 0,
      rows: [
        {
          id: "demo-1",
          uid: "demo-account-1",
          title: "整理项目资料与会议记录",
          model: "deepseek-v4.1-flash",
          status: "completed",
          activityAt: Date.now(),
          tokens: 12580,
          credits: 12.54,
        },
        {
          id: "demo-2",
          uid: "demo-account-1",
          title: "制作月度研究报告",
          model: "glm-5.3",
          status: "completed",
          activityAt: Date.now() - 3600000,
          tokens: 24900,
          credits: 28.26,
        },
        {
          id: "demo-3",
          uid: "demo-account-1",
          title: "审阅开发方案",
          model: "kimi-k3-1",
          status: "terminated",
          activityAt: Date.now() - 86400000,
          tokens: null,
          credits: null,
        },
      ],
    };
  }
  backups() {
    return [
      {
        name: "demo-backup",
        at: Date.now(),
        database: true,
        login: true,
        client: "all",
        kind: "manual",
        files: 12,
        bytes: 15 * 1024 * 1024,
        verified: true,
        accounts: true,
      },
    ];
  }
  connectionSettings() {
    return {
      workbuddyExe: "C:\\Programs\\WorkBuddy\\WorkBuddy.exe",
      codebuddyExe: "C:\\Programs\\CodeBuddy CN\\CodeBuddy CN.exe",
    };
  }
}
module.exports = { DemoBackend };
