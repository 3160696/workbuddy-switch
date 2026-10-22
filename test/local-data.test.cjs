const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { readConversations, backupList } = require("../electron/local-data.cjs");
test("conversation view preserves the database, hides deleted sessions and never invents missing credit usage", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wb-readonly-"));
  try {
    fs.mkdirSync(path.join(home, ".workbuddy"));
    const file = path.join(home, ".workbuddy/workbuddy.db"),
      db = new DatabaseSync(file);
    db.exec(
      "CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id TEXT,title TEXT,custom_title TEXT,model TEXT,status TEXT,last_activity_at INTEGER,deleted_at INTEGER); CREATE TABLE session_usage(session_id TEXT,used INTEGER,credit_json TEXT)",
    );
    const insert = db.prepare(
      "INSERT INTO sessions VALUES(?,?,?,NULL,?,?,?,?)",
    );
    insert.run(
      "visible",
      "account-a",
      "Original title",
      "model-a",
      "completed",
      1000,
      null,
    );
    insert.run(
      "missing",
      "account-b",
      "No usage",
      "model-b",
      "completed",
      2000,
      null,
    );
    insert.run(
      "deleted",
      "account-a",
      "Deleted",
      "model-a",
      "completed",
      3000,
      1,
    );
    db.prepare("INSERT INTO session_usage VALUES(?,?,?)").run(
      "visible",
      200,
      '{"model-a":1.25,"model-b":2.5}',
    );
    db.prepare("INSERT INTO session_usage VALUES(?,?,?)").run(
      "missing",
      null,
      "{}",
    );
    db.exec(
      "UPDATE sessions SET custom_title='Custom title' WHERE id='visible'",
    );
    db.close();
    const before = fs.readFileSync(file),
      value = readConversations(home);
    assert.equal(value.total, 3);
    assert.equal(value.deleted, 1);
    assert.equal(value.rows.length, 2);
    assert.equal(value.rows[0].credits, null);
    assert.equal(value.rows[1].credits, 3.75);
    assert.equal(value.rows[1].title, "Custom title");
    assert.equal(value.rows[1].uid, "account-a");
    assert.deepEqual(fs.readFileSync(file), before);
    fs.mkdirSync(path.join(home, "backups/one"), { recursive: true });
    fs.writeFileSync(path.join(home, "backups/one/auth.info"), "private-login");
    assert.equal(backupList(home)[0].login, true);
    assert.equal(backupList(home)[0].database, false);
    assert.ok(!JSON.stringify(backupList(home)).includes("private-login"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
