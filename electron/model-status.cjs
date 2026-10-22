const fs = require("node:fs");
const path = require("node:path");
const D = require("./domain.cjs");

function catalog(cfg) {
  const agents = cfg?.agents;
  const agent =
    Array.isArray(agents) &&
    (agents.find((a) => a.tags?.includes("default")) ||
      agents.find((a) => a.name === "cli") ||
      agents.find((a) => a.models?.length));
  if (!Array.isArray(agent?.models) || !agent.models.length)
    throw Error("官方模型目录暂不可用");
  const source = new Map((cfg.models || []).map((m) => [m.id, m]));
  const lines = cfg.productFeaturesConfig?.ModelRateLimitCap?.lines || [];
  const tiers = (Array.isArray(cfg.modelTiers) ? cfg.modelTiers : [])
    .flatMap((t) => (typeof t === "string" ? [t] : [t.id]))
    .filter((id) => source.has(id));
  return [...new Set([...agent.models, ...tiers])]
    .filter((id) => typeof id === "string")
    .map((id) => {
      const m = source.get(id),
        line = lines.find((l) => l.freeId === id || l.paidId === id);
      return {
        id,
        name: m?.name || id,
        credits: typeof m?.credits === "string" ? m.credits : null,
        line: line ? (id === line.freeId ? "免费线路" : "积分线路") : null,
      };
    });
}

function capEvents(contents, uid, at) {
  const events = [];
  const visit = (obj, depth = 0) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj) || depth > 5)
      return;
    for (const [key, value] of Object.entries(obj)) {
      if (!value || typeof value !== "object") continue;
      // The official account key is UID:enterpriseId. Never attribute a bucket
      // from another account just because it is in this account's storage tree.
      if (/^[\w-]{8,100}:/.test(key) && key.split(":")[0] !== uid) continue;
      const resetAt = D.shanghaiTime(value.resetAt);
      if (
        resetAt &&
        typeof key === "string" &&
        /^[\w.:-]{1,100}$/.test(key) &&
        !key.startsWith(uid)
      )
        events.push({
          uid,
          model: key,
          resetAt,
          at,
          status: 429,
          optedIn: value.optedIn === true,
          source: "WorkBuddy 本地记录",
        });
      else visit(value, depth + 1);
    }
  };
  visit(contents);
  return events;
}

function readCaps(home, accounts) {
  const root = path.join(home, ".workbuddy", "storage"),
    events = [],
    errors = {};
  if (!fs.existsSync(root)) return { events, errors, at: Date.now() };
  for (const account of accounts) {
    try {
      const dirs = fs
        .readdirSync(root)
        .filter(
          (d) =>
            d === "user-" + account.uid ||
            d.startsWith("user-" + account.uid + "-"),
        );
      const walk = (folder, depth = 0) => {
        if (depth > 6) return;
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) continue;
          const file = path.join(folder, entry.name);
          if (entry.isDirectory()) walk(file, depth + 1);
          else if (entry.name === "model-rate-limit-cap.json") {
            try {
              if (fs.statSync(file).size > 1024 * 1024) throw Error();
              events.push(
                ...capEvents(
                  JSON.parse(
                    fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""),
                  ),
                  account.uid,
                  fs.statSync(file).mtimeMs,
                ),
              );
            } catch {
              errors[account.uid] = "客户端限流记录暂时无法读取，保留上次记录";
            }
          }
        }
      };
      for (const dir of dirs) walk(path.join(root, dir));
    } catch {
      errors[account.uid] = "客户端限流目录暂时无法读取，保留上次记录";
    }
  }
  return { events, errors, at: Date.now() };
}
module.exports = { catalog, capEvents, readCaps };
