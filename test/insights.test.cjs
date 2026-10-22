const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const {
  UsageLedger,
  rangeOf,
  aggregate,
  dailyUsage,
} = require("../electron/usage-ledger.cjs");
const {
  readCaps,
  capEvents,
  catalog,
} = require("../electron/model-status.cjs");
const { Backend } = require("../electron/backend.cjs");
const D = require("../electron/domain.cjs");
const today = D.todayShanghai(),
  range = { start: today, end: today };
const row = (i, credit = 0.1) => ({
  requestId: "r" + i,
  requestTime: today + " 00:01:00",
  model: "model-a",
  client: "WorkBuddy",
  credit,
  input: "PRIVATE-PROMPT",
  inputTrunc: "PRIVATE-PROMPT",
});
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-insights-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test("official v1 ledger paginates all records and caches only billing metadata", async (t) => {
  const dataDir = fixture(t),
    calls = [];
  const b = {
    dataDir,
    accounts: [{ uid: "account-a", name: "A" }],
    api: async (_uid, endpoint, body) => {
      calls.push(body);
      assert.equal(endpoint, "/billing/meter/get-user-request-usage");
      return {
        total: 101,
        data:
          body.pageNum === 1
            ? Array.from({ length: 100 }, (_, i) => row(i))
            : [row(100, 0)],
      };
    },
  };
  const ledger = new UsageLedger(b),
    result = await ledger.query(today, today);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].pageNum, 2);
  assert.ok(!("version" in calls[0]));
  assert.equal(result.accounts[0].rows.length, 101);
  assert.equal(result.accounts[0].complete, true);
  assert.equal(result.summary[0].credits, 10);
  assert.equal(result.summary[0].requests, 101);
  assert.doesNotMatch(
    JSON.stringify(result) + fs.readFileSync(ledger.file),
    /PRIVATE-PROMPT|inputTrunc/,
  );
});
test("failed or drifting pagination keeps the previous full range and never presents partial totals as complete", async (t) => {
  const b = {
    dataDir: fixture(t),
    accounts: [{ uid: "account-a", name: "A" }],
    api: async () => ({ total: 1, data: [row(1)] }),
  };
  const ledger = new UsageLedger(b),
    first = await ledger.query(today, today);
  b.api = async (_u, _ep, body) =>
    body.pageNum === 1
      ? { total: 2, data: [row(2)] }
      : { total: 3, data: [row(3)] };
  const second = await ledger.query(today, today);
  assert.equal(second.accounts[0].complete, false);
  assert.match(second.accounts[0].error, /发生变化/);
  assert.equal(second.accounts[0].at, first.accounts[0].at);
  assert.equal(second.accounts[0].rows[0].id, "r1");
  b.api = async () => ({ total: 2, data: [row(1)] });
  assert.match(
    (await ledger.query(today, today)).accounts[0].error,
    /分页重复/,
  );
});
test("one account failing does not hide other accounts and unknown amounts remain unknown", async (t) => {
  const b = {
    dataDir: fixture(t),
    accounts: [
      { uid: "account-a", name: "A" },
      { uid: "account-b", name: "B" },
    ],
    api: async (uid) => {
      if (uid === "account-b") throw Error("offline");
      return {
        total: 3,
        data: [
          row(0, 0),
          row(1, null),
          { ...row(2, 1), client: "CodeBuddyIDE" },
        ],
      };
    },
  };
  const result = await new UsageLedger(b).query(today, today);
  assert.equal(result.accounts[0].complete, true);
  assert.equal(result.accounts[1].complete, false);
  assert.equal(aggregate(result.accounts, "WorkBuddy")[0].credits, null);
  assert.equal(aggregate(result.accounts, "WorkBuddy")[0].unknown, 1);
  assert.equal(aggregate(result.accounts, "CodeBuddyIDE")[0].credits, 1);
});
test("ledger validates dates and interprets billing wall clocks as Shanghai time", () => {
  for (const [a, b] of [
    ["2026-99-99", today],
    ["2026-02-30", today],
    [today, "2020-01-01"],
    ["2020-01-01", today],
  ])
    assert.throws(() => rangeOf(a, b));
  assert.deepEqual(rangeOf(today, today), range);
  assert.equal(D.todayShanghai(D.shanghaiTime(today + " 00:01:00")), today);
});

test("today's credits include all official clients once and sum precise fractional amounts", () => {
  const result = dailyUsage(
    {
      at: Date.now(),
      complete: true,
      rows: [
        { day: today, client: "WorkBuddy", credits: 0.1 },
        { day: today, client: "CodeBuddyIDE", credits: 0.2 },
        { day: today, client: "another-client", credits: 1.234567 },
        { day: "2020-01-01", client: "WorkBuddy", credits: 100 },
      ],
    },
    today,
  );
  assert.equal(result.credits, 1.534567);
  assert.equal(result.requests, 3);
  assert.equal(result.complete, true);
  assert.equal("rows" in result, false);
});

test("today distinguishes a confirmed zero, unknown amounts and a failed query", () => {
  assert.equal(
    dailyUsage({ rows: [], at: Date.now(), complete: true }, today).credits,
    0,
  );
  const unknown = dailyUsage(
    {
      rows: [
        { day: today, credits: 1.2 },
        { day: today, credits: null },
      ],
      at: Date.now(),
      complete: true,
    },
    today,
  );
  assert.equal(unknown.credits, null);
  assert.equal(unknown.knownCredits, 1.2);
  assert.equal(unknown.unknown, 1);
  const failed = dailyUsage(
    { rows: [], at: null, complete: false, error: "offline" },
    today,
  );
  assert.equal(failed.credits, null);
  assert.equal(failed.error, "offline");
});

test("failed daily pagination keeps the previous complete amount with a stale marker", async (t) => {
  const account = { uid: "account-a", name: "A" };
  const b = {
    dataDir: fixture(t),
    api: async () => ({ total: 1, data: [row(1, 2.345678)] }),
  };
  const ledger = new UsageLedger(b);
  const previous = await ledger.account(account, range);
  b.api = async () => {
    throw Error("offline");
  };
  const result = dailyUsage(await ledger.account(account, range), today);
  assert.equal(result.credits, 2.345678);
  assert.equal(result.at, previous.at);
  assert.equal(result.complete, false);
  assert.equal(result.error, "offline");
});

test("account refresh publishes today's official total and hides yesterday after rollover", async (t) => {
  const b = new Backend({ home: fixture(t) });
  b.accounts = [{ uid: "account-a", name: "A" }];
  b.desktopSummary = () => ({});
  b.codebuddy.summary = () => ({});
  const calls = [];
  b.api = async (_uid, endpoint, body) => {
    calls.push(endpoint);
    if (endpoint.endsWith("get-user-request-usage")) {
      assert.equal(body.startTime, today + " 00:00:00");
      assert.equal(body.endTime, today + " 23:59:59");
      return {
        total: 2,
        data: [row(1, 0.123456), { ...row(2, 0.2), client: "CodeBuddyIDE" }],
      };
    }
    if (endpoint.endsWith("get-user-resource-summary"))
      return { TotalCredits: 50 };
    if (endpoint.includes("-packages")) return { Accounts: [] };
    return {};
  };
  await b.refreshAccount(b.accounts[0]);
  assert.equal(b.state().accounts[0].todayUsage.credits, 0.323456);
  assert.equal(calls.filter((p) => p.includes("chat/completions")).length, 0);
  b.cache["account-a"].todayUsage.day = "2020-01-01";
  assert.equal(b.state().accounts[0].todayUsage, null);
});
test("model cap records use exact account buckets, preserve paid opt-in and expired deadlines", (t) => {
  const home = fixture(t),
    uid = "account-a";
  const file = path.join(
    home,
    ".workbuddy/storage/user-account-a-personal/scoped/hash/model-rate-limit-cap.json",
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      "account-a:": {
        "model-a": { resetAt: Date.now() + 60000, optedIn: true },
      },
      "account-b:": { "wrong-model": { resetAt: Date.now() + 90000 } },
    }),
  );
  const found = readCaps(home, [{ uid }]);
  assert.equal(found.events.length, 1);
  assert.equal(found.events[0].model, "model-a");
  assert.equal(found.events[0].optedIn, true);
  assert.equal(
    D.modelState(capEvents({ "model-b": { resetAt: 1 } }, uid, 5)[0]),
    "retry",
  );
  fs.writeFileSync(file, "{broken");
  assert.ok(readCaps(home, [{ uid }]).errors[uid]);
});
test("model catalog follows the official default agent and preserves price/line metadata", () => {
  const models = catalog({
    agents: [
      { name: "other", models: ["unused"] },
      {
        name: "desktop",
        tags: ["default"],
        models: ["model-a", "model-b", "model-a"],
      },
    ],
    models: [{ id: "model-a", name: "A", credits: "x0.00" }],
    modelTiers: { invalid: "shape" },
    productFeaturesConfig: {
      ModelRateLimitCap: { lines: [{ freeId: "model-a", paidId: "model-b" }] },
    },
  });
  assert.equal(models.length, 2);
  assert.equal(models[0].credits, "x0.00");
  assert.equal(models[0].line, "免费线路");
  assert.equal(models[1].line, "积分线路");
});
test("check-in skips already claimed accounts and only reports success after official confirmation", async (t) => {
  const b = new Backend({ home: fixture(t) });
  b.accounts = [{ uid: "account-a" }];
  let posts = 0;
  b.api = async (_u, ep) => {
    if (ep.includes("daily-checkin")) posts++;
    return { active: true, today_checked_in: true, today_credit: 100 };
  };
  assert.equal((await b.action("account-a", "checkin")).already, true);
  assert.equal(posts, 0);
  b.api = async (_u, ep) => {
    if (ep.includes("daily-checkin")) {
      posts++;
      return {};
    }
    return { active: true, today_checked_in: false };
  };
  await assert.rejects(b.action("account-a", "checkin"), /尚未确认/);
  assert.equal(posts, 1);
});
