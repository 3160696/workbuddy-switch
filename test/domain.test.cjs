const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const D = require("../electron/domain.cjs");
const { Backend } = require("../electron/backend.cjs");
const NOW = Date.parse("2026-10-21T06:00:00Z");
test("account ordering persists by UID across discovery/restart and rejects stale or duplicate lists", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-account-order-"));
  try {
    const createBackend = () => {
      const backend = new Backend({ home: root });
      backend.nativeAuth = path.join(root, "absent");
      backend.cache = {
        "account-a": { uid: "account-a", name: "A" },
        "account-b": { uid: "account-b", name: "B" },
        "account-c": { uid: "account-c", name: "C" },
      };
      return backend;
    };
    const backend = createBackend();
    await backend.discover();
    assert.deepEqual(
      backend
        .reorderAccounts(["account-c", "account-a", "account-b"])
        .accounts.map((a) => a.uid),
      ["account-c", "account-a", "account-b"],
    );
    const saved = fs.readFileSync(backend.orderFile, "utf8");
    assert.deepEqual(JSON.parse(saved), [
      "account-c",
      "account-a",
      "account-b",
    ]);
    for (const invalid of [
      ["account-c", "account-a", "account-a"],
      ["account-c", "account-a"],
      ["account-c", "account-a", "foreign"],
      null,
    ]) {
      assert.throws(() => backend.reorderAccounts(invalid), /账号列表已变化/);
      assert.equal(fs.readFileSync(backend.orderFile, "utf8"), saved);
    }
    const restarted = createBackend();
    restarted.accountAliases = { "account-a": "buddy1" };
    restarted.cache["account-d"] = { uid: "account-d", name: "D" };
    await restarted.discover();
    const state = restarted.state();
    assert.deepEqual(
      state.accounts.map((a) => a.uid),
      ["account-c", "account-a", "account-b", "account-d"],
    );
    assert.equal(
      state.accounts.find((a) => a.uid === "account-a").name,
      "A · buddy1",
    );
    delete restarted.cache["account-a"];
    await restarted.discover();
    assert.deepEqual(
      restarted.state().accounts.map((a) => a.uid),
      ["account-c", "account-b", "account-d"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("official balance is authoritative, including zero; malformed data never becomes zero", () => {
  assert.equal(D.balance({ TotalCredits: "0" }).remaining, 0);
  assert.equal(
    D.balance({
      TotalCredits: "2.15",
      Packages: [{ CycleRemainCapacity: "999" }],
    }).remaining,
    2.15,
  );
  for (const TotalCredits of [null, "", "nope"])
    assert.throws(() => D.balance({ TotalCredits }));
});
test("Shanghai timestamps and numerical milliseconds have identical expiry", () => {
  assert.equal(D.shanghaiTime("2026-10-21 14:00:00"), NOW);
  assert.equal(D.shanghaiTime(NOW), NOW);
  assert.equal(D.shanghaiTime(NOW / 1000), NOW);
  assert.equal(
    D.todayShanghai(Date.parse("2026-10-20T17:00:00Z")),
    "2026-10-21",
  );
});
test("precise amounts, cycle deadline and resource identity are preserved", () => {
  const input = {
    ResourceId: "r1",
    CapacityRemain: 4,
    CycleCapacityRemainPrecise: "4.982",
    CapacitySizePrecise: "10",
    DeductionEndTime: NOW + 1000,
    ExpiredTime: "2026-10-20 14:00:00",
    CapacityType: 4,
    AccountAttributes: [{ Key: "grantSource", Value: "daily_checkin" }],
  };
  const rows = D.packages([input, input], NOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].remaining, 4.982);
  assert.equal(rows[0].end, NOW + 1000);
  assert.equal(rows[0].name, "每日签到");
  assert.equal(rows[0].cycle, true);
});
test("used/expired packages do not inflate imminent expiry, missing amount stays unknown", () => {
  const rows = D.packages(
    [
      {
        ResourceId: "live",
        CapacityRemainPrecise: "3",
        DeductionEndTime: NOW + 1000,
      },
      { ResourceId: "used", CapacityRemain: 0, DeductionEndTime: NOW + 1000 },
      { ResourceId: "expired", CapacityRemain: 99, DeductionEndTime: NOW - 1 },
      { ResourceId: "unknown", DeductionEndTime: NOW + 1000 },
    ],
    NOW,
  );
  assert.equal(D.expirySummary(rows, NOW).soon, 3);
  assert.equal(rows.find((r) => r.id === "unknown").remaining, null);
});
test("reset timestamps use UTC+8 unless an explicit offset is present", () => {
  assert.equal(D.resetAt("Try at 2026-10-21 14:00:00 (UTC+8)"), NOW);
  assert.equal(D.resetAt("2026-10-21T06:00:00Z"), NOW);
  assert.equal(D.resetAt("Rate limit exceeded"), null);
  assert.equal(D.modelState({ status: 429, resetAt: NOW }, NOW + 1), "retry");
  assert.equal(D.modelState({ status: 429, resetAt: null }, NOW), "limited");
  assert.equal(D.modelState(null, NOW), "unknown");
});
test("HTTP 200 business error is rejected and cannot become empty balance", async () => {
  const b = new Backend({
    home: os.tmpdir(),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ code: 10085, data: { TotalCredits: "0" } }),
    }),
  });
  b.credentials.set("uid", { access: "synthetic", uid: "uid" });
  await assert.rejects(b.api("uid", "/test", {}), /10085/);
});
test("partial API failure preserves cached values with explicit error and old timestamp", async () => {
  const b = new Backend({ home: os.tmpdir() });
  b.cache = {
    u: {
      uid: "u",
      balance: { remaining: 42 },
      balanceAt: 1,
      packages: [{ id: "saved" }],
      packagesAt: 2,
    },
  };
  b.api = async (_u, endpoint) => {
    if (endpoint === "/v3/config")
      return { agents: [{ name: "cli", models: ["new"] }], models: [] };
    throw Error("Offline");
  };
  b.packagePages = async () => {
    throw Error("Offline");
  };
  await b.refreshAccount({ uid: "u", name: "Account" });
  assert.equal(b.cache.u.balance.remaining, 42);
  assert.equal(b.cache.u.balanceAt, 1);
  assert.ok(b.cache.u.errors.balance);
  assert.equal(b.cache.u.models[0].id, "new");
});
test("discovery ignores external gateway credentials and preserves local account cache", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-hub-test-"));
  try {
    fs.mkdirSync(path.join(root, ".config", "magpie"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".config", "magpie", "plugin-auth.json"),
      JSON.stringify({
        "workbuddy#a": {
          uid: "account-a",
          access: "synthetic-secret",
          accountId: "A",
        },
        "workbuddy-ai#b": { uid: "account-international", access: "excluded" },
      }),
    );
    const b = new Backend({ home: root });
    fs.mkdirSync(path.join(b.vault, "account-archived", "snapshot"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(b.vault, "account-archived", "snapshot", "workbuddy.db"),
      "preserved conversation backup",
    );
    b.nativeAuth = path.join(root, "absent");
    b.cache = { "account-b": { uid: "account-b", name: "B" } };
    await b.discover();
    assert.deepEqual(b.accounts.map((a) => a.uid).sort(), ["account-b"]);
    assert.ok(!JSON.stringify(b.state()).includes("synthetic-secret"));
    assert.equal(
      b.accounts.find((a) => a.uid === "account-b").hasCredential,
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refresh contacts only official account metadata endpoints and never model inference", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wb-official-")),
    calls = [];
  try {
    const b = new Backend({
      home,
      fetchImpl: async (url, options) => {
        calls.push([url, options.method]);
        const data = url.endsWith("/v3/config")
          ? {
              agents: [{ name: "cli", models: ["official-model"] }],
              models: [],
            }
          : url.includes("packages")
            ? { Accounts: [] }
            : url.endsWith("get-user-request-usage")
              ? { total: 0, data: [] }
              : { TotalCredits: "12" };
        return { ok: true, status: 200, json: async () => ({ code: 0, data }) };
      },
    });
    b.nativeAuth = path.join(home, "absent");
    b.discover = async () => {
      b.accounts = [{ uid: "account-a", name: "A" }];
      b.credentials.set("account-a", { uid: "account-a", access: "synthetic" });
    };
    await b.refresh();
    assert.deepEqual(
      calls.map(([url]) => url).sort(),
      [
        "/v3/config",
        "/v2/chat/busy",
        "/billing/meter/checkin-activity-status",
        "/billing/meter/get-user-resource-summary",
        "/billing/meter/get-user-request-usage",
        "/billing/meter/get-user-resource-free-packages",
        "/billing/meter/get-user-resource-paid-packages",
      ]
        .map((endpoint) => "https://copilot.tencent.com" + endpoint)
        .sort(),
    );
    assert.equal(b.state().accounts[0].balance.remaining, 12);
    assert.equal(b.state().accounts[0].todayUsage.credits, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
