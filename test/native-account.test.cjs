const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const {
  NativeAccounts,
  identityOf,
  mergeIdentity,
} = require("../electron/native-account.cjs");
function token(uid, exp = Math.floor(Date.now() / 1000) + 3600) {
  return (
    "synthetic." +
    Buffer.from(JSON.stringify({ sub: uid, exp })).toString("base64url") +
    ".signature"
  );
}
function doc(uid) {
  return {
    account: { uid, nickname: uid },
    auth: { accessToken: token(uid) },
    accounts: [{ uid }],
    allAccounts: [{ uid }],
  };
}

function importDoc(
  uid,
  issuer = "https://www.codebuddy.cn/auth/realms/copilot",
) {
  const claims = {
    sub: uid,
    exp: Math.floor(Date.now() / 1000) + 3600,
    iss: issuer,
  };
  return {
    uid,
    access_token:
      "synthetic." +
      Buffer.from(JSON.stringify(claims)).toString("base64url") +
      ".signature",
    refresh_token: "synthetic-refresh",
    nickname: "Imported account",
  };
}

test("JSON imports both official formats without altering the running desktop identity", () =>
  fixture(async ({ native, backend, calls }) => {
    const a = importDoc("11111111-1111-4111-8111-111111111111");
    const b = importDoc(
      "22222222-2222-4222-8222-222222222222",
      "https://copilot.tencent.com/auth/realms/copilot",
    );
    const before = fs.readFileSync(backend.nativeAuth);
    assert.equal(
      await native.importDocuments([
        a,
        {
          account: { uid: b.uid, nickname: "Native" },
          auth: { accessToken: b.access_token, refreshToken: b.refresh_token },
        },
      ]),
      2,
    );
    assert.equal(native.snapshot(a.uid).account.nickname, "Imported account");
    assert.equal(native.snapshot(b.uid).account.nickname, "Native");
    assert.equal(native.snapshot(a.uid).auth.domain, "www.codebuddy.cn");
    assert.deepEqual(fs.readFileSync(backend.nativeAuth), before);
    assert.deepEqual(calls, []);
  }));

test("mixed invalid import rejects the whole batch, including a mismatched identity and foreign issuer", () =>
  fixture(async ({ native, calls }) => {
    const a = importDoc("11111111-1111-4111-8111-111111111111");
    const b = importDoc("22222222-2222-4222-8222-222222222222");
    b.access_token = a.access_token;
    await assert.rejects(native.importDocuments([a, b]), /不一致/);
    assert.equal(native.snapshot(a.uid), null);
    await assert.rejects(
      native.importDocuments(importDoc(a.uid, "https://example.invalid")),
      /国内版/,
    );
    await assert.rejects(native.importDocuments([a, a]), /重复/);
    const missing = { ...a };
    delete missing.refresh_token;
    await assert.rejects(native.importDocuments(missing), /刷新凭据/);
    assert.deepEqual(calls, []);
  }));

test("import verifies official access and backs up the prior snapshot before replacing it", () =>
  fixture(async ({ native, backend }) => {
    const a = importDoc("11111111-1111-4111-8111-111111111111");
    backend.fetch = async () => ({
      ok: false,
      json: async () => ({ code: 401 }),
    });
    await assert.rejects(native.importDocuments(a), /验证失败/);
    assert.equal(native.snapshot(a.uid), null);
    backend.fetch = async () => ({ ok: true, json: async () => ({ code: 0 }) });
    await native.importDocuments(a);
    await native.importDocuments({ ...a, nickname: "New name" });
    const root = path.join(backend.dataDir, "import-backups");
    const backup = fs.readFileSync(
      path.join(root, fs.readdirSync(root)[0], a.uid + ".info"),
    );
    assert.equal(JSON.parse(backup).account.nickname, "Imported account");
    assert.equal(native.snapshot(a.uid).account.nickname, "New name");
  }));
test("desktop identity rejects mismatched or expired tokens", () => {
  assert.throws(() => identityOf(token("account-a"), "account-b"), /不一致/);
  assert.throws(() => identityOf(token("account-a", 1), "account-a"), /过期/);
  assert.equal(identityOf(token("account-a"), "account-a").sub, "account-a");
});
test("switching preserves all saved identities without renaming their UIDs", () => {
  const merged = mergeIdentity(doc("account-a"), doc("account-b"), "account-b");
  assert.equal(merged.account.uid, "account-b");
  assert.deepEqual(
    merged.allAccounts.map((a) => a.uid),
    ["account-a", "account-b"],
  );
  assert.throws(() =>
    mergeIdentity(doc("account-a"), doc("account-b"), "account-c"),
  );
});
async function fixture(task) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wb-switch-native-"));
  try {
    const backend = {
      home: root,
      dataDir: path.join(root, "data"),
      vault: path.join(root, "legacy"),
      nativeAuth: path.join(root, "official", "auth.info"),
      decodeNative: async (d) => ({ access: d.auth.accessToken }),
      headers: () => ({}),
      fetch: async () => ({ ok: true, json: async () => ({ code: 0 }) }),
    };
    fs.mkdirSync(path.dirname(backend.nativeAuth), { recursive: true });
    fs.writeFileSync(backend.nativeAuth, JSON.stringify(doc("account-a")));
    const calls = [];
    const native = new NativeAccounts(backend, {
      processAction: async (mode) => {
        calls.push(mode);
        return { running: mode === "status" };
      },
      activityCheck: async () => {},
    });
    fs.mkdirSync(native.folder, { recursive: true });
    fs.writeFileSync(
      path.join(native.folder, "account-b.info"),
      JSON.stringify(doc("account-b")),
    );
    fs.mkdirSync(path.join(root, ".config/magpie"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".config/magpie/logins.json"),
      "independent-harness-session",
    );
    fs.mkdirSync(path.join(root, ".workbuddy"), { recursive: true });
    const db = new DatabaseSync(path.join(root, ".workbuddy/workbuddy.db"));
    db.exec(
      "CREATE TABLE sessions(id TEXT PRIMARY KEY, user_id TEXT, status TEXT, deleted_at INTEGER, title TEXT); CREATE TABLE session_usage(session_id TEXT PRIMARY KEY, credit_json TEXT); CREATE TABLE automations(id TEXT PRIMARY KEY, owner_user_id TEXT, prompt TEXT)",
    );
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(
      "source-chat",
      "account-a",
      "completed",
      null,
      "Keep this conversation",
    );
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(
      "target-chat",
      "account-b",
      "completed",
      null,
      "Target conversation",
    );
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(
      "third-chat",
      "account-c",
      "completed",
      null,
      "Other account",
    );
    db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(
      "deleted-chat",
      "account-a",
      "completed",
      123,
      "Previously deleted",
    );
    db.prepare("INSERT INTO session_usage VALUES(?,?)").run(
      "source-chat",
      '{"charge":12.5}',
    );
    db.prepare("INSERT INTO automations VALUES(?,?,?)").run(
      "auto-a",
      "account-a",
      "Keep prompt",
    );
    db.close();
    await task({ root, backend, native, calls });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test("desktop switch carries conversations, preserves content and other accounts, and backs up the database", () =>
  fixture(async ({ root, backend, native, calls }) => {
    await native.switchTo("account-b");
    assert.equal(
      JSON.parse(fs.readFileSync(backend.nativeAuth)).account.uid,
      "account-b",
    );
    assert.deepEqual(calls, ["status", "stop", "start"]);
    assert.ok(fs.existsSync(path.join(native.folder, "account-a.info")));
    assert.equal(
      fs.readFileSync(path.join(root, ".config/magpie/logins.json"), "utf8"),
      "independent-harness-session",
    );
    const db = new DatabaseSync(path.join(root, ".workbuddy/workbuddy.db"));
    assert.equal(
      db.prepare("SELECT user_id FROM sessions WHERE id='source-chat'").get()
        .user_id,
      "account-b",
    );
    assert.equal(
      db.prepare("SELECT title FROM sessions WHERE id='source-chat'").get()
        .title,
      "Keep this conversation",
    );
    assert.equal(
      db.prepare("SELECT user_id FROM sessions WHERE id='third-chat'").get()
        .user_id,
      "account-c",
    );
    assert.equal(
      db
        .prepare("SELECT deleted_at FROM sessions WHERE id='deleted-chat'")
        .get().deleted_at,
      123,
    );
    assert.equal(
      db.prepare("SELECT credit_json FROM session_usage").get().credit_json,
      '{"charge":12.5}',
    );
    assert.equal(
      db.prepare("SELECT owner_user_id FROM automations").get().owner_user_id,
      "account-b",
    );
    db.close();
    assert.equal(
      fs.readdirSync(path.join(backend.dataDir, "backups")).length,
      1,
    );
    const folder = fs.readdirSync(path.join(backend.dataDir, "backups"))[0];
    const backup = new DatabaseSync(
      path.join(backend.dataDir, "backups", folder, "workbuddy.db"),
    );
    assert.equal(
      backup
        .prepare("SELECT user_id FROM sessions WHERE id='source-chat'")
        .get().user_id,
      "account-a",
    );
    backup.close();
  }));
test("busy client aborts before stopping or modifying any identity", () =>
  fixture(async ({ backend, native, calls }) => {
    const before = fs.readFileSync(backend.nativeAuth, "utf8");
    native.activityCheck = async () => {
      throw Error("Task running");
    };
    await assert.rejects(native.switchTo("account-b"), /Task running/);
    assert.deepEqual(calls, ["status"]);
    assert.equal(fs.readFileSync(backend.nativeAuth, "utf8"), before);
  }));
test("failed startup restores the original login and conversation ownership", () =>
  fixture(async ({ root, backend, native, calls }) => {
    let starts = 0;
    native.processAction = async (mode) => {
      calls.push(mode);
      if (mode === "start" && ++starts === 1) throw Error("Launch failed");
      return { running: true };
    };
    await assert.rejects(native.switchTo("account-b"), /Launch failed/);
    assert.equal(
      JSON.parse(fs.readFileSync(backend.nativeAuth)).account.uid,
      "account-a",
    );
    assert.equal(starts, 2);
    const db = new DatabaseSync(path.join(root, ".workbuddy/workbuddy.db"));
    assert.equal(
      db.prepare("SELECT user_id FROM sessions WHERE id='source-chat'").get()
        .user_id,
      "account-a",
    );
    assert.equal(
      db.prepare("SELECT user_id FROM sessions WHERE id='target-chat'").get()
        .user_id,
      "account-b",
    );
    assert.equal(
      db.prepare("SELECT owner_user_id FROM automations").get().owner_user_id,
      "account-a",
    );
    db.close();
  }));

test("switching back carries both existing and transferred conversations without losing rows", () =>
  fixture(async ({ root, native }) => {
    await native.switchTo("account-b");
    await native.switchTo("account-a");
    const db = new DatabaseSync(path.join(root, ".workbuddy/workbuddy.db"));
    assert.equal(db.prepare("SELECT count(*) AS n FROM sessions").get().n, 4);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM sessions WHERE user_id='account-a' AND deleted_at IS NULL",
        )
        .get().n,
      2,
    );
    assert.equal(
      db.prepare("SELECT user_id FROM sessions WHERE id='third-chat'").get()
        .user_id,
      "account-c",
    );
    db.close();
  }));

test("unreadable conversation database aborts before identity modification and restarts original client", () =>
  fixture(async ({ root, backend, native, calls }) => {
    const file = path.join(root, ".workbuddy/workbuddy.db");
    fs.writeFileSync(file, "invalid database");
    const before = fs.readFileSync(backend.nativeAuth, "utf8");
    await assert.rejects(native.switchTo("account-b"));
    assert.equal(fs.readFileSync(backend.nativeAuth, "utf8"), before);
    assert.equal(calls.at(-1), "start");
  }));
test("restart never changes the selected identity", () =>
  fixture(async ({ backend, native, calls }) => {
    const before = fs.readFileSync(backend.nativeAuth, "utf8");
    await native.restart();
    assert.deepEqual(calls, ["status", "stop", "start"]);
    assert.equal(fs.readFileSync(backend.nativeAuth, "utf8"), before);
  }));

test("missing current login aborts before stopping the client", () =>
  fixture(async ({ backend, native, calls }) => {
    fs.unlinkSync(backend.nativeAuth);
    await assert.rejects(native.switchTo("account-b"), /请先在 WorkBuddy/);
    assert.deepEqual(calls, []);
  }));
