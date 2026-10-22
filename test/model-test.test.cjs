const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { Backend } = require("../electron/backend.cjs");
const D = require("../electron/domain.cjs");
const {
  SOURCE,
  ENDPOINT,
  compareModels,
  readReply,
  replyParser,
  testOfficial,
  ModelTests,
} = require("../electron/model-test.cjs");
const resetMessage =
  "您的使用量已超出频率限制，将在 2026-10-22 12:49:03 UTC+8 重置，您也可以切换其他模型继续使用。";
const resetTime = Date.parse("2026-10-22T12:49:03+08:00");
const sse = (text, status = 200) =>
  new Response(text, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
const success = () =>
  sse(
    'data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
  );

test("DeepSeek 4.1 ranks first, including paid variants, while 4.10 and 4.0 stay below", () => {
  const ids = [
    "hy3",
    "deepseek-v4.10",
    "deepseek-v4-pro",
    "deepseek-v4.1-pro",
    "deepseek-v4.1-flash-paid",
    "deepseek-v4.1-flash",
  ];
  const sorted = ids
    .map((id) => ({ id }))
    .sort(compareModels)
    .map((m) => m.id);
  assert.deepEqual(sorted.slice(0, 3), [
    "deepseek-v4.1-flash",
    "deepseek-v4.1-flash-paid",
    "deepseek-v4.1-pro",
  ]);
});

test("official 429 returns the exact Shanghai reset time, also inside HTTP 200 SSE errors", async () => {
  const limited = await readReply(
    new Response(JSON.stringify({ code: 429, message: resetMessage }), {
      status: 429,
    }),
  );
  assert.equal(limited.status, 429);
  assert.equal(limited.resetAt, resetTime);
  assert.equal(limited.message, resetMessage);
  const embedded = await readReply(
    sse(
      `event: error\r\ndata: ${JSON.stringify({ error: { code: "rate_limit", message: resetMessage } })}\r\n\r\n`,
    ),
  );
  assert.equal(embedded.httpStatus, 200);
  assert.equal(embedded.status, 429);
  assert.equal(embedded.resetAt, resetTime);
  assert.equal(D.modelState(embedded, resetTime - 1), "limited");
  assert.equal(D.modelState(embedded, resetTime + 1), "retry");
});

test("missing reset times remain unknown; Retry-After and explicit offsets are honored", async () => {
  const r = await readReply(
    new Response('{"error":{"message":"Too many requests"}}', { status: 429 }),
  );
  assert.equal(r.resetAt, null);
  const p = replyParser(429, "60", [], 10000);
  assert.equal(p.result().resetAt, 70000);
  const date = replyParser(429, "Thu, 22 Oct 2026 04:49:03 GMT");
  assert.equal(date.result().resetAt, resetTime);
  for (const value of [
    "2026-10-22 12:49:03 (UTC+8)",
    "2026-10-22T04:49:03Z",
    "2026-10-22T13:49:03+09:00",
    "2026-10-22T12:49:03+0800",
    "2026-10-22 12:49:03",
  ])
    assert.equal(D.resetAt(value), resetTime, value);
});

test("SSE decoding handles split UTF-8 and stops at DONE without waiting for a socket close", async () => {
  const bytes = new TextEncoder().encode(
    'data: {"choices":[{"delta":{"content":"收到"}}]}\n\ndata: [DONE]\n\n',
  );
  let canceled = false;
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 2)
        controller.enqueue(bytes.slice(i, i + 2));
      // Intentionally keep the stream open. DONE must terminate the read.
    },
    cancel() {
      canceled = true;
    },
  });
  const result = await readReply(
    new Response(stream, { headers: { "content-type": "text/event-stream" } }),
  );
  assert.equal(result.reply, "收到");
  assert.equal(result.status, 200);
  assert.equal(canceled, true);
});

test("empty/truncated streams and provider errors cannot report availability", async () => {
  assert.equal((await readReply(sse("data: [DONE]\n\n"))).status, 0);
  const truncated = await readReply(
    sse('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
  );
  assert.equal(truncated.status, 0);
  assert.equal(truncated.reply, "partial");
  const afterContent = await readReply(
    sse(
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\nevent: error\ndata: {"error":{"message":"provider failed"}}\n\n',
    ),
  );
  assert.equal(afterContent.status, 0);
  assert.equal(afterContent.message, "provider failed");
  const invalidLogin = await readReply(
    new Response('{"message":"login expired","debug":"PRIVATE-EXTRA"}', {
      status: 401,
    }),
  );
  assert.equal(invalidLogin.status, 401);
  assert.equal(invalidLogin.message, "login expired");
  assert.doesNotMatch(JSON.stringify(invalidLogin), /PRIVATE-EXTRA/);
});

test("manual tests call only the official host with bounded output and scrub credentials", async () => {
  const secret = "synthetic-private-access",
    calls = [];
  const backend = {
    credential: (uid) => ({ uid, access: secret }),
    headers: (auth) => ({
      Authorization: "Bearer " + auth.access,
      "X-User-Id": auth.uid,
    }),
    fetch: async (url, options) => {
      calls.push({ url, options });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "OK " + secret } }] }),
      );
    },
  };
  const result = await testOfficial(
    backend,
    { uid: "account-a", model: "deepseek-v4.1-flash" },
    new AbortController().signal,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers["X-User-Id"], "account-a");
  assert.equal(JSON.parse(calls[0].options.body).max_tokens, 64);
  assert.equal(JSON.parse(calls[0].options.body).model, "deepseek-v4.1-flash");
  assert.match(result.reply, /OK/);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private-access/);
});

test("timeouts record an unknown deadline; cancellation discards the interrupted request", async () => {
  const backend = {
    credential: () => ({ access: "synthetic" }),
    headers: () => ({}),
    fetch: async (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(Error("aborted")), {
          once: true,
        });
      }),
  };
  const item = { uid: "account-a", model: "model-a" };
  const result = await testOfficial(
    backend,
    item,
    new AbortController().signal,
    5,
  );
  assert.equal(result.status, 0);
  assert.equal(result.resetAt, null);
  assert.match(result.message, /超时/);
  const controller = new AbortController();
  const pending = testOfficial(backend, item, controller.signal);
  controller.abort();
  assert.equal(await pending, null);
});

test("batches bound concurrency, isolate account/model outcomes and stop without issuing queued calls", async () => {
  let active = 0,
    max = 0;
  const gates = [],
    results = [];
  const tests = new ModelTests(async (item) => {
    max = Math.max(max, ++active);
    await new Promise((resolve) => gates.push(resolve));
    active--;
    return { ...item, status: item.uid === "account-a" ? 429 : 200 };
  });
  tests.start(
    [
      { uid: "account-a", model: "same-model" },
      { uid: "account-b", model: "same-model" },
      { uid: "account-c", model: "next-model" },
    ],
    (r) => results.push(r),
  );
  assert.equal(tests.state().active.length, 2);
  assert.throws(() => tests.start([], () => {}), /正在进行/);
  gates.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(tests.state().completed, 1);
  assert.equal(tests.state().active.length, 2);
  gates.splice(0).forEach((resolve) => resolve());
  await tests.finished;
  assert.equal(max, 2);
  assert.deepEqual(tests.state().counts, { success: 2, limited: 1, error: 0 });
  assert.equal(results.length, 3);
  assert.equal("controller" in tests.state(), false);
  tests.start(
    Array.from({ length: 5 }, (_, i) => ({ uid: "account-" + i, model: "m" })),
    (r) => results.push(r),
  );
  tests.cancel();
  gates.splice(0).forEach((resolve) => resolve());
  await tests.finished;
  assert.equal(tests.state().completed, 0);
  assert.equal(tests.state().canceled, true);
  assert.equal(results.length, 3);
  assert.equal(gates.length, 0);
});

test("backend validates the whole batch before requests, stores per-account results, and keeps manual records on restart", async (t) => {
  t.mock.method(Date, "now", () => resetTime - 60000);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wb-manual-models-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  const backend = new Backend({
    home,
    fetchImpl: async (_url, options) => {
      calls.push(options.headers["X-User-Id"]);
      return options.headers["X-User-Id"] === "account-a"
        ? new Response(JSON.stringify({ code: 429, message: resetMessage }), {
            status: 429,
          })
        : success();
    },
  });
  backend.accounts = ["account-a", "account-b"].map((uid) => ({
    uid,
    hasCredential: true,
  }));
  for (const { uid } of backend.accounts) {
    backend.credentials.set(uid, { uid, access: "synthetic" });
    backend.cache[uid] = { models: [{ id: "deepseek-v4.1-flash" }] };
  }
  backend.desktopSummary = () => ({});
  backend.codebuddy.summary = () => ({});
  const item = { uid: "account-a", model: "deepseek-v4.1-flash" };
  for (const bad of [
    [item, { ...item, model: "unknown" }],
    [item, item],
    [{ ...item, uid: "other" }],
    [],
  ])
    assert.throws(() => backend.startModelTests(bad));
  assert.equal(calls.length, 0);
  backend.startModelTests([item, { ...item, uid: "account-b" }]);
  await backend.modelTests.finished;
  const state = backend.state();
  assert.equal(state.accounts[0].models[0].state, "limited");
  assert.equal(state.accounts[1].models[0].state, "success");
  assert.equal(state.accounts[1].models[0].event.resetAt, null);
  assert.equal(state.accounts[0].models[0].event.resetAt, resetTime);
  assert.equal(state.accounts[0].models[0].canTest, true);
  assert.equal(
    new Backend({ home }).events["account-a/deepseek-v4.1-flash"].source,
    SOURCE,
  );
  assert.doesNotMatch(
    JSON.stringify(state),
    /synthetic|Authorization|accessToken/,
  );
});
