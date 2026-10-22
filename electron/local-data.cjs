const fs = require("node:fs");
const path = require("node:path");

function readConversations(home) {
  const file = path.join(home, ".workbuddy", "workbuddy.db");
  if (!fs.existsSync(file)) return { rows: [], total: 0, deleted: 0 };
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const counts = db
      .prepare(
        "SELECT count(*) AS total, sum(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted FROM sessions",
      )
      .get();
    const rows = db
      .prepare(
        `SELECT s.id, s.user_id AS uid, COALESCE(s.custom_title,s.title,'未命名对话') AS title,
      s.model, s.status, s.last_activity_at AS activityAt, u.used AS tokens, u.credit_json
      FROM sessions s LEFT JOIN session_usage u ON u.session_id=s.id
      WHERE s.deleted_at IS NULL ORDER BY s.last_activity_at DESC`,
      )
      .all()
      .map((r) => {
        let credits = null;
        try {
          const values = Object.values(JSON.parse(r.credit_json));
          if (
            values.length &&
            values.every((v) => typeof v === "number" && Number.isFinite(v))
          )
            credits = values.reduce((a, b) => a + b, 0);
        } catch {
          /* Unavailable usage remains unknown. */
        }
        const { credit_json, ...row } = r;
        return { ...row, credits };
      });
    return { ...counts, deleted: counts.deleted || 0, rows };
  } finally {
    db.close();
  }
}

function backupList(dataDir) {
  const root = path.join(dataDir, "backups");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const folder = path.join(root, e.name);
      let manifest;
      try {
        manifest = JSON.parse(
          fs.readFileSync(path.join(folder, "manifest.json"), "utf8"),
        );
      } catch {}
      const files = Array.isArray(manifest?.files)
        ? manifest.files.map((f) => f.path)
        : [];
      return {
        name: e.name,
        at: fs.statSync(folder).mtimeMs,
        database:
          fs.existsSync(path.join(folder, "workbuddy.db")) ||
          files.includes("workbuddy/workbuddy.db") ||
          files.includes("codebuddy/codebuddy-sessions.vscdb"),
        login:
          fs.existsSync(path.join(folder, "auth.info")) ||
          files.includes("workbuddy/auth.info") ||
          files.includes("codebuddy/User/globalStorage/state.vscdb"),
        client: manifest?.client || "workbuddy",
      };
    })
    .sort((a, b) => b.at - a.at);
}

module.exports = { readConversations, backupList };
