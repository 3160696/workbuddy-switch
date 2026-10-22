const DAY = 86400000;
function number(v) {
  return v === "" || v == null || !Number.isFinite(Number(v))
    ? null
    : Number(v);
}
function shanghaiTime(v) {
  if (typeof v === "number")
    return Number.isFinite(v) && v > 0 ? (v < 1e11 ? v * 1000 : v) : null;
  if (!v || typeof v !== "string") return null;
  const s = v.trim();
  const normalized = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d$/.test(s)
    ? s.replace(" ", "T") + "+08:00"
    : s;
  const t = Date.parse(normalized);
  return Number.isFinite(t) && t > 0 ? t : null;
}
function todayShanghai(now = Date.now()) {
  return new Date(now + 8 * 3600000).toISOString().slice(0, 10);
}
function balance(data) {
  const total = number(data?.TotalCredits);
  if (total == null) throw new Error("官方余额字段缺失，暂不能确认余额");
  const groups = (data.CreditGroups || []).map((g) => ({
    name: g.Name,
    kind: g.Kind,
    remaining: number(g.CycleRemainCapacity),
    total: number(g.CycleTotalCapacity),
    used: number(g.CycleUsedCapacity),
  }));
  const capacity =
    groups.length && groups.every((g) => g.total != null)
      ? groups.reduce((s, g) => s + g.total, 0)
      : null;
  const used =
    groups.length && groups.every((g) => g.used != null)
      ? groups.reduce((s, g) => s + g.used, 0)
      : capacity == null
        ? null
        : Math.max(0, capacity - total);
  return {
    remaining: total,
    total: capacity,
    used,
    plan: data.SubscriptionPackageName || "未提供套餐名称",
    groups,
  };
}
function packages(rows, now = Date.now()) {
  const seen = new Set();
  return rows
    .flatMap((p, index) => {
      const id =
        p.ResourceId ||
        [p.PackageCode, p.AccountId, p.CycleStartTime, index].join(":");
      if (seen.has(id)) return [];
      seen.add(id);
      const attrs = Object.fromEntries(
        (p.AccountAttributes || []).map((x) => [x.Key, x.Value]),
      );
      const remain = number(
        p.CycleCapacityRemainPrecise ??
          p.CapacityRemainPrecise ??
          p.CycleCapacityRemain ??
          p.CapacityRemain,
      );
      const total = number(
        p.CycleCapacitySizePrecise ??
          p.CapacitySizePrecise ??
          p.CycleCapacitySize ??
          p.CapacitySize,
      );
      const end =
        shanghaiTime(p.DeductionEndTime) || shanghaiTime(p.CycleEndTime);
      const source = attrs.grantSource || "";
      const label =
        source === "daily_checkin"
          ? "每日签到"
          : source === "welcome_gift"
            ? "新用户奖励"
            : source.startsWith("growth_task")
              ? "成长任务奖励"
              : attrs.grantReason || p.PackageName || "积分包";
      return [
        {
          id,
          name: label,
          originalName: p.PackageName,
          remaining: remain,
          total,
          end,
          start:
            shanghaiTime(p.DeductionStartTime) ||
            shanghaiTime(p.CycleStartTime),
          cycle: p.CapacityType === 4,
          source,
          state:
            remain == null
              ? "unknown"
              : remain <= 0
                ? "used"
                : end && end <= now
                  ? "expired"
                  : "active",
        },
      ];
    })
    .sort((a, b) => (a.end || Infinity) - (b.end || Infinity));
}
function expirySummary(items, now = Date.now()) {
  const active = items.filter(
    (p) => p.state === "active" && p.remaining > 0 && p.end > now,
  );
  const next = active[0]?.end || null;
  return {
    next,
    nextAmount: active
      .filter((p) => p.end === next)
      .reduce((s, p) => s + p.remaining, 0),
    soon: active
      .filter((p) => p.end <= now + 7 * DAY)
      .reduce((s, p) => s + p.remaining, 0),
  };
}
function resetAt(text) {
  if (typeof text !== "string") return null;
  const match = text.match(
    /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:\s*\(?(?:UTC|GMT)?\s*(Z|[+-]\d{1,2}(?::?\d{2})?)\)?)?/i,
  );
  if (!match) return null;
  const offset = match[3]?.toUpperCase();
  const zone = !offset
    ? "+08:00"
    : offset === "Z"
      ? "Z"
      : offset[0] +
        offset
          .slice(1)
          .replace(":", "")
          .padStart(offset.length <= 3 ? 2 : 4, "0")
          .padEnd(4, "0")
          .replace(/(\d{2})(\d{2})/, "$1:$2");
  return shanghaiTime(match[1] + "T" + match[2] + zone);
}
function modelState(event, now = Date.now()) {
  if (!event) return "unknown";
  if (event.status === 429)
    return event.resetAt
      ? event.resetAt > now
        ? "limited"
        : "retry"
      : "limited";
  if (event.status >= 200 && event.status < 300) return "success";
  return "error";
}
module.exports = {
  DAY,
  number,
  shanghaiTime,
  todayShanghai,
  balance,
  packages,
  expirySummary,
  resetAt,
  modelState,
};
