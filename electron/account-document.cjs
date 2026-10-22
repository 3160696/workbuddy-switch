const { identityOf } = require("./native-account.cjs");

const ISSUERS = new Set([
  "https://copilot.tencent.com/auth/realms/copilot",
  "https://www.codebuddy.cn/auth/realms/copilot",
  "https://www.workbuddy.cn/auth/realms/copilot",
]);

// Internal only. Never return this document through renderer IPC.
async function validDocument(backend, doc) {
  const uid = doc?.account?.uid;
  if (typeof uid !== "string" || !/^[\w-]{8,100}$/.test(uid))
    throw new Error("账号快照不完整");
  const decoded = await backend.decodeNative(doc, { refresh: true });
  const claims = identityOf(decoded.access, uid);
  if (!ISSUERS.has(claims.iss)) throw new Error("仅支持国内版官方账号");
  if (typeof decoded.refresh !== "string" || !decoded.refresh)
    throw new Error("缺少有效刷新凭据，请重新保存完整登录");
  if (decoded.refresh.split(".").length === 3) {
    const refresh = identityOf(decoded.refresh, uid);
    if (!ISSUERS.has(refresh.iss)) throw new Error("刷新凭据来源不匹配");
  }
  const response = await backend.fetch(
    "https://copilot.tencent.com/billing/meter/get-user-resource-summary",
    {
      method: "POST",
      headers: backend.headers({
        uid,
        access: decoded.access,
        domain: doc.auth?.domain,
      }),
      body: "{}",
      redirect: "error",
      signal: AbortSignal.timeout(18000),
    },
  );
  const result = await response.json();
  if (!response.ok || Number(result.code) !== 0)
    throw new Error("官方服务未确认登录有效，请更新账号登录");
  const account = {
    uid,
    nickname: decoded.name || uid.slice(0, 8),
    type: doc.account.type || "personal",
    pluginEnabled: true,
  };
  return {
    account,
    accounts: [account],
    allAccounts: [account],
    auth: {
      accessToken: decoded.access,
      refreshToken: decoded.refresh,
      tokenType: "Bearer",
      domain: doc.auth?.domain || "copilot.tencent.com",
      scope:
        doc.auth?.scope ||
        claims.scope ||
        "openid profile offline_access email",
      expiresAt: claims.exp * 1000,
    },
  };
}
module.exports = { validDocument };
