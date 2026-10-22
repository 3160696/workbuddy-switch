const fs = require("node:fs");
const path = require("node:path");
const D = require("./domain.cjs");
const { atomicWrite } = require("./native-account.cjs");

function rangeOf(start, end) {
  const valid = (v) =>
    typeof v === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    Number.isFinite(Date.parse(v + "T00:00:00Z")) &&
    new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v;
  if (!valid(start) || !valid(end)) throw Error("请选择有效日期");
  const days = (Date.parse(end) - Date.parse(start)) / D.DAY;
  if (days < 0 || days > 30 || end > D.todayShanghai())
    throw Error("可查询截至今天、最多 31 天的账单");
  return { start, end };
}

function usageRow(raw, range) {
  const at = D.shanghaiTime(raw?.requestTime);
  const day = at && D.todayShanghai(at);
  if (
    !raw ||
    typeof raw.requestId !== "string" ||
    !raw.requestId ||
    !at ||
    day < range.start ||
    day > range.end ||
    typeof raw.model !== "string"
  )
    throw Error("官方账单字段已变化，请稍后重试");
  // Never cache or expose input/inputTrunc, prompts, or arbitrary response fields.
  return {
    id: raw.requestId.slice(0, 150),
    at,
    day,
    model: raw.model.slice(0, 100),
    client: typeof raw.client === "string" ? raw.client.slice(0, 80) : "未标明",
    credits: D.number(raw.credit),
  };
}

function aggregate(accounts, client = "all") {
  const groups = new Map();
  for (const a of accounts)
    for (const row of a.rows || []) {
      if (client !== "all" && row.client !== client) continue;
      const key = JSON.stringify([a.uid, row.day, row.model, row.client]);
      const g = groups.get(key) || {
        uid: a.uid,
        account: a.name,
        day: row.day,
        model: row.model,
        client: row.client,
        requests: 0,
        knownCredits: 0,
        unknown: 0,
      };
      g.requests++;
      if (row.credits == null) g.unknown++;
      else g.knownCredits += Math.round(row.credits * 1e6);
      groups.set(key, g);
    }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      knownCredits: g.knownCredits / 1e6,
      credits: g.unknown ? null : g.knownCredits / 1e6,
    }))
    .sort(
      (a, b) =>
        b.day.localeCompare(a.day) ||
        a.account.localeCompare(b.account) ||
        (b.credits || 0) - (a.credits || 0),
    );
}

function dailyUsage(report, day) {
  const rows = (report.rows || []).filter((row) => row.day === day);
  const unknown = rows.filter((row) => row.credits == null).length;
  const knownCredits =
    rows.reduce((sum, row) => sum + Math.round((row.credits || 0) * 1e6), 0) /
    1e6;
  return {
    day,
    credits: report.at && !unknown ? knownCredits : null,
    knownCredits,
    unknown,
    requests: rows.length,
    complete: report.complete,
    at: report.at,
    error: report.error || null,
  };
}

class UsageLedger {
  constructor(backend) {
    this.backend = backend;
    this.file = path.join(backend.dataDir, "usage-ledger.json");
    try {
      this.cache = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      this.cache = {};
    }
    this.pending = new Map();
  }
  async account(account, range) {
    const key = [account.uid, range.start, range.end].join("/");
    if (this.pending.has(key)) return this.pending.get(key);
    const task = (async () => {
      const rows = [],
        ids = new Set();
      let total;
      try {
        for (let pageNum = 1; pageNum <= 100; pageNum++) {
          const data = await this.backend.api(
            account.uid,
            "/billing/meter/get-user-request-usage",
            {
              startTime: range.start + " 00:00:00",
              endTime: range.end + " 23:59:59",
              pageNum,
              pageSize: 100,
            },
          );
          if (
            !Array.isArray(data.data) ||
            !Number.isSafeInteger(data.total) ||
            data.total < 0
          )
            throw Error("官方账单分页格式已变化");
          if (total !== undefined && total !== data.total)
            throw Error("查询期间账单发生变化，请重新查询");
          total = data.total;
          for (const raw of data.data) {
            const row = usageRow(raw, range);
            if (ids.has(row.id)) throw Error("官方账单分页重复，请重新查询");
            ids.add(row.id);
            rows.push(row);
          }
          if (rows.length > total)
            throw Error("官方账单数量不一致，请重新查询");
          if (rows.length === total) {
            const value = {
              uid: account.uid,
              name: account.name,
              rows,
              total,
              at: Date.now(),
              complete: true,
            };
            this.cache[key] = value;
            // Bound cached ranges without deleting the latest useful report.
            const entries = Object.entries(this.cache)
              .sort((a, b) => b[1].at - a[1].at)
              .slice(0, 30);
            atomicWrite(this.file, JSON.stringify(Object.fromEntries(entries)));
            this.cache = Object.fromEntries(entries);
            return value;
          }
          if (!data.data.length)
            throw Error("官方账单未返回完整分页，请重新查询");
        }
        throw Error("账单超过 10000 条，请缩小日期范围");
      } catch (e) {
        const old = this.cache[key];
        return {
          ...(old || {
            uid: account.uid,
            name: account.name,
            rows: [],
            at: null,
          }),
          complete: false,
          error: require("./backend.cjs").safeError(e),
          attemptedAt: Date.now(),
        };
      }
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }
  async query(start, end) {
    const range = rangeOf(start, end),
      accounts = [];
    const queue = [...this.backend.accounts];
    await Promise.all(
      [0, 1].map(async () => {
        while (queue.length)
          accounts.push(await this.account(queue.shift(), range));
      }),
    );
    accounts.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    return { range, accounts, summary: aggregate(accounts), at: Date.now() };
  }
}
module.exports = { UsageLedger, rangeOf, usageRow, aggregate, dailyUsage };
