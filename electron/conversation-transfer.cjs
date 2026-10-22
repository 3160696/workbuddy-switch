const fs = require("node:fs");
const path = require("node:path");

// Called only after the official client has stopped. All content and usage rows
// keep their IDs; only the owner of the departing account's records changes.
function transferConversations(home, from, to, backupDir) {
  const file = path.join(home, ".workbuddy", "workbuddy.db");
  if (from === to || !fs.existsSync(file)) return null;
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file);
  let transaction = false;
  try {
    db.exec("PRAGMA busy_timeout=5000");
    if (Object.values(db.prepare("PRAGMA quick_check").get())[0] !== "ok")
      throw new Error("对话数据库校验失败，已停止切换");
    fs.mkdirSync(backupDir, { recursive: true });
    const backup = path.join(backupDir, "workbuddy.db");
    // VACUUM INTO includes committed WAL data; copying only .db can miss it.
    db.exec("VACUUM INTO '" + backup.replace(/'/g, "''") + "'");
    db.exec("BEGIN IMMEDIATE");
    transaction = true;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    const entries = [];
    for (const [table, owner] of [["sessions", "user_id"], ["automations", "owner_user_id"]]) {
      if (!tables.includes(table)) continue;
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
      if (!columns.includes(owner) || !columns.includes("id"))
        throw new Error("对话数据库结构已变化，已停止切换");
      const ids = db.prepare(`SELECT id FROM ${table} WHERE ${owner}=?`).all(from).map(r => r.id);
      entries.push({ table, owner, ids });
    }
    const journal = { version: 1, from, to, entries, backup };
    fs.writeFileSync(path.join(backupDir, "conversation-transfer.json"), JSON.stringify(journal, null, 2), { mode: 0o600 });
    for (const { table, owner, ids } of entries) {
      const update = db.prepare(`UPDATE ${table} SET ${owner}=? WHERE id=? AND ${owner}=?`);
      for (const id of ids) update.run(to, id, from);
    }
    db.exec("COMMIT");
    transaction = false;
    return journal;
  } finally {
    if (transaction) db.exec("ROLLBACK");
    db.close();
  }
}

function rollbackConversations(home, journal) {
  if (!journal) return;
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(home, ".workbuddy", "workbuddy.db"));
  let transaction = false;
  try {
    db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    transaction = true;
    for (const { table, owner, ids } of journal.entries) {
      if (!((table === "sessions" && owner === "user_id") || (table === "automations" && owner === "owner_user_id")))
        throw new Error("恢复记录无效");
      const update = db.prepare(`UPDATE ${table} SET ${owner}=? WHERE id=? AND ${owner}=?`);
      for (const id of ids) update.run(journal.from, id, journal.to);
    }
    db.exec("COMMIT");
    transaction = false;
  } finally {
    if (transaction) db.exec("ROLLBACK");
    db.close();
  }
}

module.exports = { transferConversations, rollbackConversations };
