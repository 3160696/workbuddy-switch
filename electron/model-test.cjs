const { randomUUID } = require("node:crypto");
const D = require("./domain.cjs");

const SOURCE = "手动测试 · 官方接口";
const ENDPOINT = "https://copilot.tencent.com/v2/chat/completions";
const deepseek41 = (m) =>
  /deepseek[\s_-]*v?4\.1(?:\D|$)/i.test(m.id + " " + m.name);
const compareModels = (a, b) =>
  Number(deepseek41(b)) - Number(deepseek41(a)) ||
  a.id.localeCompare(b.id) ||
  String(a.uid || "").localeCompare(String(b.uid || ""));

function safeText(value, secrets = [], max = 2000) {
  let text = typeof value === "string" ? value : "";
  for (const secret of secrets.filter(
    (s) => typeof s === "string" && s.length > 5,
  ))
    text = text.split(secret).join("[凭据已隐藏]");
  return text
    .replace(/Bearer\s+[^\s"<>]+/gi, "[凭据已隐藏]")
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[凭据已隐藏]")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .slice(0, max);
}

// Only keep text/status fields. Never persist or send a complete API envelope
// (which could contain credentials or unrelated account metadata) to the UI.
function replyParser(
  httpStatus,
  retryAfter,
  secrets = [],
  now = Date.now(),
  requireTerminal = false,
) {
  let reply = "",
    reasoning = "",
    message = "",
    code = null,
    finish = null;
  let failed = httpStatus < 200 || httpStatus >= 300,
    status = httpStatus;
  let resetAt = null,
    sawFrame = false,
    done = false;
  function frame(value, event = "") {
    sawFrame = true;
    if (!value || typeof value !== "object") return;
    const error = value.error || value.data?.error;
    const badCode = value.code != null && ![0, "0"].includes(value.code);
    const text =
      typeof error === "string"
        ? error
        : error?.message ||
          value.message ||
          value.msg ||
          value.data?.message ||
          "";
    if (failed && text) message = safeText(text, secrets);
    if (
      error ||
      badCode ||
      event === "error" ||
      /超出.*频率限制|触发.*限流|rate.?limit|too many requests/i.test(text)
    ) {
      failed = true;
      code = error?.code ?? value.code ?? code;
      message = safeText(text, secrets) || "官方返回错误，未提供说明";
      const returnedStatus = Number(error?.status || value.status);
      if (returnedStatus >= 400 && returnedStatus <= 599)
        status = returnedStatus;
      if (
        Number(code) === 429 ||
        /超出.*频率限制|触发.*限流|rate.?limit|too many requests/i.test(message)
      )
        status = 429;
      resetAt = D.resetAt(message) || resetAt;
      if (status >= 200 && status < 300) status = 0;
    }
    for (const choice of value.choices || []) {
      const part = choice.delta || choice.message;
      if (typeof part?.content === "string") reply += part.content;
      if (typeof part?.reasoning_content === "string")
        reasoning += part.reasoning_content;
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    if (reply.length > 8000 || reasoning.length > 8000)
      throw Error("官方回复超出测试读取上限");
  }
  return {
    frame,
    terminal: () => done || (failed && !!message),
    done: () => {
      done = true;
    },
    result(raw = "") {
      if (!failed && !reply && !reasoning) {
        failed = true;
        status = 0;
        message =
          sawFrame || done
            ? "官方未返回模型内容，不能确认可用"
            : "官方响应格式无法识别";
      }
      if (!failed && requireTerminal && !done && !finish) {
        failed = true;
        status = 0;
        message = "已收到内容片段，但响应未正常结束，请手动重试确认";
      }
      if (failed && !message)
        message = safeText(raw, secrets) || `官方服务 HTTP ${httpStatus}`;
      if (status === 429) {
        resetAt ||= D.resetAt(message);
        if (!resetAt && retryAfter) {
          const seconds = Number(retryAfter);
          resetAt =
            Number.isFinite(seconds) && seconds >= 0
              ? now + seconds * 1000
              : D.shanghaiTime(retryAfter);
        }
      }
      return {
        status,
        httpStatus,
        code: code == null ? null : safeText(String(code), secrets, 80),
        resetAt: status === 429 ? resetAt : null,
        message: failed
          ? message
          : "官方已返回模型内容" +
            (finish === "length" ? "（已到测试输出上限）" : ""),
        reply: safeText(reply, secrets, 1000),
        reasoning: !reply ? safeText(reasoning, secrets, 500) : "",
        source: SOURCE,
      };
    },
  };
}

async function readReply(response, secrets = []) {
  const sse = /text\/event-stream/i.test(
    response.headers.get("content-type") || "",
  );
  const parser = replyParser(
    response.status,
    response.headers.get("retry-after"),
    secrets,
    Date.now(),
    sse,
  );
  const reader = response.body?.getReader();
  if (!reader) return parser.result();
  const decoder = new TextDecoder();
  let pending = "",
    raw = "",
    size = 0,
    eventName = "",
    data = [];
  const dispatch = () => {
    if (data.length) {
      const text = data.join("\n");
      if (text.trim() === "[DONE]") parser.done();
      else parser.frame(JSON.parse(text), eventName);
    }
    data = [];
    eventName = "";
  };
  const line = (text) => {
    text = text.replace(/\r$/, "");
    if (!text) dispatch();
    else if (text.startsWith("data:"))
      data.push(text.slice(5).replace(/^ /, ""));
    else if (text.startsWith("event:")) eventName = text.slice(6).trim();
  };
  try {
    reading: while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 128 * 1024) throw Error("官方回复超出测试读取上限");
      const text = decoder.decode(chunk.value, { stream: true });
      if (!sse) raw += text;
      else {
        pending += text;
        let split;
        while ((split = pending.indexOf("\n")) >= 0) {
          line(pending.slice(0, split));
          pending = pending.slice(split + 1);
          if (parser.terminal()) break reading;
        }
      }
    }
    const tail = decoder.decode();
    if (sse) {
      if (!parser.terminal()) {
        line(pending + tail);
        dispatch();
      }
    } else {
      raw += tail;
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        /* Plain HTTP error. */
      }
      if (value) {
        parser.frame(value);
        raw = "";
      }
    }
    return parser.result(raw);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function testOfficial(backend, item, signal, timeoutMs = 45000) {
  const started = Date.now(),
    auth = backend.credential(item.uid);
  if (!auth?.access) throw Error("该账号缺少有效登录，请重新导入 JSON");
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted) abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    const conversation = randomUUID().replace(/-/g, ""),
      message = randomUUID().replace(/-/g, "");
    const response = await backend.fetch(ENDPOINT, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        ...backend.headers(auth),
        Accept: "text/event-stream",
        "X-Conversation-ID": conversation,
        "X-Session-ID": conversation,
        "X-Conversation-Request-ID": randomUUID().replace(/-/g, ""),
        "X-Conversation-Message-ID": message,
        "X-Request-ID": message,
      },
      body: JSON.stringify({
        model: item.model,
        stream: true,
        max_tokens: 64,
        messages: [
          { role: "system", content: "你是一个助手。" },
          { role: "user", content: "这是可用性测试，请仅回复 OK。" },
        ],
      }),
    });
    const result = await readReply(response, [auth.access, auth.refresh]);
    return {
      ...item,
      ...result,
      at: Date.now(),
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    if (signal.aborted) return null;
    return {
      ...item,
      status: 0,
      httpStatus: null,
      resetAt: null,
      at: Date.now(),
      elapsedMs: Date.now() - started,
      source: SOURCE,
      message: controller.signal.aborted
        ? "测试超时（45 秒），未取得解锁时间"
        : /读取上限/.test(error.message)
          ? error.message
          : "测试连接中断或响应格式异常，请手动重试",
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

// Jobs start only through the explicit manual-test IPC. At most two tiny
// official requests run at a time, with no retries or automatic paid fallback.
class ModelTests {
  constructor(perform) {
    this.perform = perform;
    this.job = null;
  }
  state() {
    if (!this.job) return null;
    const { controller, ...publicState } = this.job;
    return structuredClone(publicState);
  }
  start(items, record, changed = () => {}) {
    if (this.job?.running) throw Error("模型测试正在进行，请等待或先停止");
    const job = (this.job = {
      running: true,
      total: items.length,
      completed: 0,
      active: [],
      counts: { success: 0, limited: 0, error: 0 },
      canceled: false,
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      controller: new AbortController(),
    });
    const queue = [...items];
    changed();
    this.finished = Promise.all(
      [0, 1].map(async () => {
        while (queue.length && !job.controller.signal.aborted) {
          const item = queue.shift();
          job.active.push(item);
          changed();
          try {
            const result = await this.perform(item, job.controller.signal);
            if (result && !job.controller.signal.aborted) {
              await record(result);
              job.completed++;
              job.counts[
                result.status === 429
                  ? "limited"
                  : result.status >= 200 && result.status < 300
                    ? "success"
                    : "error"
              ]++;
            }
          } catch {
            job.error = "测试结果无法保存，请检查本地数据目录后重试";
            job.controller.abort();
          } finally {
            job.active = job.active.filter((a) => a !== item);
            changed();
          }
        }
      }),
    ).finally(() => {
      job.running = false;
      job.finishedAt = Date.now();
      changed();
    });
    return this.state();
  }
  cancel() {
    if (this.job?.running) {
      this.job.canceled = true;
      this.job.controller.abort();
    }
    return this.state();
  }
}

module.exports = {
  SOURCE,
  ENDPOINT,
  compareModels,
  safeText,
  replyParser,
  readReply,
  testOfficial,
  ModelTests,
};
