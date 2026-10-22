const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { Backend } = require("../electron/backend.cjs");
const { STORAGE_KEY } = require("../electron/codebuddy-account.cjs");
const { validDocument } = require("../electron/account-document.cjs");
const { within } = require("../electron/backup-store.cjs");
const A = "11111111-1111-4111-8111-111111111111",
  B = "22222222-2222-4222-8222-222222222222";
const crypto = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from("encrypted:" + s),
  decryptString: (b) => {
    const s = b.toString();
    if (!s.startsWith("encrypted:")) throw Error("invalid");
    return s.slice(10);
  },
};
function token(uid, exp = Math.floor(Date.now() / 1000) + 3600) {
  return (
    "synthetic." +
    Buffer.from(
      JSON.stringify({
        sub: uid,
        exp,
        iss: "https://www.codebuddy.cn/auth/realms/copilot",
      }),
    ).toString("base64url") +
    ".signature"
  );
}
function doc(uid, exp) {
  return {
    account: { uid, nickname: uid === A ? "First" : "Second" },
    auth: { accessToken: token(uid, exp), refreshToken: token(uid) },
    accounts: [{ uid }],
    allAccounts: [{ uid }],
  };
}
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}
async function fixture(task) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "buddy-dual-"));
  try {
    const b = new Backend({
      home: root,
      crypto,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({ code: 0, data: { TotalCredits: 10 } }),
      }),
    });
    b.nativeAuth = path.join(root, "live-workbuddy/auth.info");
    write(b.nativeAuth, doc(A));
    write(path.join(b.native.folder, A + ".info"), doc(A));
    write(path.join(b.native.folder, B + ".info"), doc(B));
    fs.mkdirSync(path.dirname(b.codebuddy.storage), { recursive: true });
    const db = new DatabaseSync(b.codebuddy.storage);
    db.exec("CREATE TABLE ItemTable(key TEXT PRIMARY KEY,value BLOB)");
    const first = Buffer.from(
      JSON.stringify(crypto.encryptString(JSON.stringify(doc(A)))),
    );
    db.prepare("INSERT INTO ItemTable VALUES(?,?)").run(STORAGE_KEY, first);
    db.prepare("INSERT INTO ItemTable VALUES(?,?)").run(
      "editor.settings",
      Buffer.from("keep-settings"),
    );
    db.close();
    fs.mkdirSync(path.join(root, ".workbuddy"), { recursive: true });
    const wb = new DatabaseSync(path.join(root, ".workbuddy/workbuddy.db"));
    wb.exec(
      "CREATE TABLE retained(id TEXT PRIMARY KEY, content TEXT); INSERT INTO retained VALUES('chat','keep conversation')",
    );
    wb.close();
    const cb = new DatabaseSync(
      path.join(b.codebuddy.profile, "codebuddy-sessions.vscdb"),
    );
    cb.exec(
      "CREATE TABLE sessions(id TEXT PRIMARY KEY, content TEXT); INSERT INTO sessions VALUES('cb-chat','keep codebuddy conversation')",
    );
    cb.close();
    write(
      path.join(
        b.codebuddy.profile,
        "User/workspaceStorage/workspace/editors.json",
      ),
      { unsaved: "keep editor state" },
    );
    const calls = [];
    let running = true;
    b.codebuddy.processAction = async (mode) => {
      calls.push(mode);
      if (mode === "stop") running = false;
      if (mode === "start") running = true;
      return { running };
    };
    await task({ b, root, calls, first });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test("CodeBuddy switch backs up first and changes only its encrypted secret, preserving both clients conversations", () =>
  fixture(async ({ b, root, calls, first }) => {
    const wb = fs.readFileSync(b.nativeAuth),
      dbBefore = fs.readFileSync(path.join(root, ".workbuddy/workbuddy.db"));
    await b.codebuddy.switchTo(B);
    assert.equal(b.codebuddy.readCurrent().account.uid, B);
    assert.equal(b.codebuddy.readCurrent().auth.domain, "copilot.tencent.com");
    assert.deepEqual(calls, ["status", "stop", "status", "start"]);
    assert.deepEqual(fs.readFileSync(b.nativeAuth), wb);
    assert.deepEqual(
      fs.readFileSync(path.join(root, ".workbuddy/workbuddy.db")),
      dbBefore,
    );
    const db = new DatabaseSync(b.codebuddy.storage, { readOnly: true });
    assert.equal(
      Buffer.from(
        db
          .prepare("SELECT value FROM ItemTable WHERE key=?")
          .get("editor.settings").value,
      ).toString(),
      "keep-settings",
    );
    db.close();
    const backup = b.backups()[0];
    assert.equal(backup.client, "codebuddy");
    assert.equal(backup.kind, "switch");
    assert.equal(b.backupStore.verify(backup.name).ok, true);
    const saved = new DatabaseSync(
      path.join(
        b.backupStore.directory(backup.name),
        "codebuddy/User/globalStorage/state.vscdb",
      ),
      { readOnly: true },
    );
    assert.deepEqual(
      Buffer.from(
        saved
          .prepare("SELECT value FROM ItemTable WHERE key=?")
          .get(STORAGE_KEY).value,
      ),
      first,
    );
    saved.close();
    const chats = new DatabaseSync(
      path.join(b.codebuddy.profile, "codebuddy-sessions.vscdb"),
      { readOnly: true },
    );
    assert.equal(
      chats.prepare("SELECT content FROM sessions").get().content,
      "keep codebuddy conversation",
    );
    chats.close();
  }));
test("CodeBuddy refused exit aborts without changing login or stopping WorkBuddy", () =>
  fixture(async ({ b, first }) => {
    b.codebuddy.processAction = async (mode) => {
      if (mode === "stop") throw Error("unsaved editor");
      return { running: true };
    };
    await assert.rejects(b.codebuddy.switchTo(B), /unsaved/);
    assert.deepEqual(Buffer.from(b.codebuddy.encryptedLogin()), first);
    assert.deepEqual(b.backups(), []);
  }));
test("CodeBuddy startup failure restores only the login key, preserving concurrent editor changes", () =>
  fixture(async ({ b, first }) => {
    let running = true,
      starts = 0;
    b.codebuddy.processAction = async (mode) => {
      if (mode === "stop") running = false;
      if (mode === "start") {
        if (starts++ === 0) {
          const db = new DatabaseSync(b.codebuddy.storage);
          db.prepare("UPDATE ItemTable SET value=? WHERE key=?").run(
            "new-editor-state",
            "editor.settings",
          );
          db.close();
          throw Error("startup failed");
        }
        running = true;
      }
      return { running };
    };
    await assert.rejects(b.codebuddy.switchTo(B), /startup failed/);
    assert.deepEqual(Buffer.from(b.codebuddy.encryptedLogin()), first);
    const db = new DatabaseSync(b.codebuddy.storage);
    assert.equal(
      db
        .prepare("SELECT value FROM ItemTable WHERE key=?")
        .get("editor.settings").value,
      "new-editor-state",
    );
    db.close();
  }));
test("invalid CodeBuddy target fails before any process control", () =>
  fixture(async ({ b, calls, first }) => {
    write(path.join(b.native.folder, B + ".info"), doc(B, 1));
    await assert.rejects(b.codebuddy.switchTo(B), /过期/);
    assert.deepEqual(calls, []);
    assert.deepEqual(Buffer.from(b.codebuddy.encryptedLogin()), first);
  }));
test("portable export verifies complete credentials and round-trips through import without changing either live login", () =>
  fixture(async ({ b }) => {
    const wb = fs.readFileSync(b.nativeAuth),
      cb = Buffer.from(b.codebuddy.encryptedLogin());
    const exported = await b.exportAccounts([B]);
    assert.equal(exported.documents.length, 1);
    assert.equal(exported.skipped.length, 0);
    const item = exported.documents[0];
    assert.equal(item.account.uid, B);
    assert.equal(typeof item.auth.refreshToken, "string");
    await b.native.importDocuments(item);
    assert.equal(b.native.snapshot(B).account.uid, B);
    assert.deepEqual(fs.readFileSync(b.nativeAuth), wb);
    assert.deepEqual(Buffer.from(b.codebuddy.encryptedLogin()), cb);
    assert.ok(!JSON.stringify(b.state()).includes(item.auth.accessToken));
  }));
test("batch export skips expired accounts; single invalid export and mismatched refresh fail", () =>
  fixture(async ({ b }) => {
    write(path.join(b.native.folder, B + ".info"), doc(B, 1));
    const all = await b.exportAccounts("all");
    assert.equal(all.documents.length, 1);
    assert.equal(all.skipped[0].name, "Second");
    await assert.rejects(b.exportAccounts([B]), /过期/);
    const bad = doc(B);
    bad.auth.refreshToken = token(A);
    await assert.rejects(validDocument(b, bad), /不一致/);
  }));
test("manual backup includes committed WAL data and integrity checks reject damaged or escaping paths", () =>
  fixture(async ({ b, root }) => {
    const source = new DatabaseSync(path.join(root, ".workbuddy/workbuddy.db"));
    source.exec(
      "PRAGMA journal_mode=WAL; INSERT INTO retained VALUES('wal-chat','committed WAL content')",
    );
    const made = await b.backupStore.create("all");
    assert.ok(made.files > 4);
    assert.equal(b.backupStore.verify(made.name).ok, true);
    const saved = new DatabaseSync(
      path.join(b.backupStore.directory(made.name), "workbuddy/workbuddy.db"),
      { readOnly: true },
    );
    assert.equal(
      saved.prepare("SELECT content FROM retained WHERE id=?").get("wal-chat")
        .content,
      "committed WAL content",
    );
    saved.close();
    source.close();
    assert.throws(() => b.backupStore.directory("../outside"), /无效/);
    assert.throws(() => within(root, "../outside"), /越界/);
    fs.appendFileSync(
      path.join(b.backupStore.directory(made.name), "accounts", A + ".info"),
      "corrupted",
    );
    await assert.rejects(b.backupStore.restoreAccounts(made.name), /完整性/);
    assert.equal(b.native.snapshot(A).account.uid, A);
  }));
test("restore account snapshots preserves live clients and creates an overwrite backup", () =>
  fixture(async ({ b }) => {
    const wb = fs.readFileSync(b.nativeAuth),
      cb = Buffer.from(b.codebuddy.encryptedLogin());
    const made = await b.backupStore.create("all");
    const updated = doc(B);
    updated.account.nickname = "New local name";
    write(path.join(b.native.folder, B + ".info"), updated);
    assert.equal((await b.backupStore.restoreAccounts(made.name)).count, 2);
    assert.equal(b.native.snapshot(B).account.nickname, "Second");
    assert.deepEqual(fs.readFileSync(b.nativeAuth), wb);
    assert.deepEqual(Buffer.from(b.codebuddy.encryptedLogin()), cb);
    assert.ok(
      fs.readdirSync(path.join(b.dataDir, "import-backups")).length > 0,
    );
  }));
