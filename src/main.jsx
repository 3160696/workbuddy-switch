import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  FluentProvider,
  webLightTheme,
  Button,
  ProgressBar,
  Spinner,
  Input,
  Select,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  MessageBar,
  MessageBarBody,
} from "@fluentui/react-components";
import {
  SquaresFour,
  Wallet,
  ChatsCircle,
  Cpu,
  Gift,
  GearSix,
  ArrowsClockwise,
  DownloadSimple,
  FolderOpen,
  ShieldCheck,
  DotsSixVertical,
  ArrowRight,
  CheckCircle,
  X,
} from "@phosphor-icons/react";
import brandIcon from "../assets/brand/icon.svg";
import "./style.css";

const api = window.hub;
const theme = {
  ...webLightTheme,
  fontFamilyBase: '"Segoe UI", "Microsoft YaHei UI", sans-serif',
  colorBrandBackground: "#276554",
  colorBrandBackgroundHover: "#205747",
  colorBrandBackgroundPressed: "#184536",
  colorBrandForeground1: "#276554",
  colorBrandStroke1: "#276554",
};
const number = (n) =>
  n == null
    ? "—"
    : new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(n);
function date(value, seconds = false) {
  if (!value) return "—";
  const time = typeof value === "number" && value < 1e11 ? value * 1000 : value;
  const d = new Date(time);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        ...(seconds ? { second: "2-digit" } : {}),
        hour12: false,
      });
}
const pages = [
  ["overview", "账号总览", SquaresFour],
  ["credits", "积分明细", Wallet],
  ["conversations", "本机对话", ChatsCircle],
  ["models", "模型记录", Cpu],
  ["rewards", "签到与福利", Gift],
  ["settings", "设置与备份", GearSix],
];
function Empty({ children = "暂时没有记录" }) {
  return <div className="empty">{children}</div>;
}
function Note({ children }) {
  return (
    <div className="note">
      <ShieldCheck size={19} />
      <span>{children}</span>
    </div>
  );
}
function Usage({ balance }) {
  const known = balance?.total > 0 && balance?.used != null;
  return (
    <div className="usage">
      <div>
        <span>已用 / 总额</span>
        <span>
          {number(balance?.used)} / {number(balance?.total)}
        </span>
      </div>
      <ProgressBar
        aria-label={known ? `已用 ${number(balance.used)} 积分` : "总额待查询"}
        value={
          known ? Math.max(0, Math.min(1, balance.used / balance.total)) : 0
        }
      />
    </div>
  );
}
function TodayUsage({ value, day }) {
  const current = value?.day === day ? value : null;
  const status = !current
    ? "等待查询"
    : !current.complete
      ? current.at
        ? "未更新"
        : "查询失败"
      : current.unknown
        ? "金额待确认"
        : "";
  return (
    <div
      className="account-amount today-usage"
      title={[
        `${day} 北京时间 00:00 起，全部客户端的官方账单`,
        current?.at ? `最近完整查询：${date(current.at)}` : "",
        current?.error || "",
      ]
        .filter(Boolean)
        .join("\n")}
    >
      <strong>{number(current?.credits)}</strong>
      {status && <span className="daily-status">{status}</span>}
    </div>
  );
}
const defaultOverviewModel = "deepseek-v4.1-flash";
function modelLabel(model) {
  return (
    {
      "deepseek-v4.1-flash": "DeepSeek 4.1 Flash",
      "deepseek-v4-pro": "DeepSeek 4 Pro",
    }[model?.id] ||
    model?.name ||
    model?.id ||
    "模型"
  );
}
function AccountModelStatus({ account, modelId, job, batch, onDetails }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  const model = account.models?.find((m) => m.id === modelId);
  const event = model?.event;
  const testing =
    job?.running &&
    job.active?.some(
      (item) => item.uid === account.uid && item.model === modelId,
    );
  const queued =
    job?.running &&
    batch?.startedAt === job.startedAt &&
    batch.model === modelId &&
    batch.uids.includes(account.uid) &&
    !(event?.at >= job.startedAt);
  const limited = event?.status === 429;
  const reset = limited && event.resetAt ? event.resetAt : null;
  const waiting = reset > now;
  const success = event?.status >= 200 && event.status < 300;
  const status = testing
    ? "测试中…"
    : queued
      ? "等待测试"
      : !model
        ? "未提供此模型"
        : !model.canTest && !event
          ? "无法测试"
          : limited
            ? reset && !waiting
              ? "已到恢复时间"
              : "限流中"
            : success
              ? "最近测试成功"
              : event
                ? "最近测试失败"
                : "尚未测试";
  const minutes = waiting ? Math.ceil((reset - now) / 60000) : 0;
  return (
    <div
      className="account-model-status"
      data-account={account.uid}
      data-model={modelId}
      aria-label={`${account.name} 的 ${modelLabel(model || { id: modelId })} 状态`}
      aria-live="polite"
      title={
        event?.at ? `记录于 ${date(event.at, true)}（北京时间）` : undefined
      }
    >
      <div className="account-model-heading">
        <span
          className={`badge${testing || queued || !model ? " neutral" : limited ? " amber" : event && !success ? " red" : !event ? " neutral" : ""}`}
        >
          {testing && <Spinner size="extra-tiny" />}
          {status}
        </span>
        <Button
          appearance="subtle"
          size="small"
          icon={<ArrowRight size={14} />}
          aria-label="查看 / 测试"
          title="查看此账号的模型记录 / 手动测试"
          onClick={onDetails}
        />
      </div>
      {testing || queued ? (
        <span className="muted">
          {testing ? "正在等待官方返回" : "将按顺序测试一次"}
        </span>
      ) : !model ? (
        <span className="muted">此账号不参与本次测试</span>
      ) : reset ? (
        <>
          <span className="account-model-deadline">
            <time dateTime={new Date(reset).toISOString()}>
              {date(reset, true)}
            </time>
          </span>
          <span className="account-model-remaining">
            {waiting
              ? `剩余 ${minutes >= 60 ? Math.floor(minutes / 60) + " 小时 " : ""}${minutes % 60} 分钟`
              : "请手动测试确认"}
          </span>
        </>
      ) : (
        <span className="muted">
          {limited
            ? "官方尚未提供解锁时间"
            : event?.at
              ? `${date(event.at)} 测试`
              : !model.canTest
                ? "缺少登录或官方模型目录"
                : "解锁时间待测试确认"}
        </span>
      )}
    </div>
  );
}
function Errors({ account }) {
  const errors = Object.values(account.errors || {});
  return errors.length || account.authError ? (
    <div className="warning">
      {[...new Set([...errors, account.authError].filter(Boolean))].join("；")}{" "}
      · 显示最近成功查询的数据
    </div>
  ) : null;
}
function Table({ headings, children }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {headings.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
function App() {
  const [data, setData] = useState({ accounts: [], desktop: {} });
  const [today, setToday] = useState(dayString);
  const dragUid = useRef(null);
  const [dragging, setDragging] = useState(null);
  const [dropTarget, setDropTarget] = useState(null);
  const [orderMessage, setOrderMessage] = useState("");
  const [overviewModel, setOverviewModel] = useState(() => {
    try {
      return localStorage.getItem("overview-model") || defaultOverviewModel;
    } catch {
      return defaultOverviewModel;
    }
  });
  const [overviewStarting, setOverviewStarting] = useState(false);
  const overviewRequest = useRef(false);
  const [overviewBatch, setOverviewBatch] = useState(null);
  const [modelFocus, setModelFocus] = useState("");
  const [page, setPage] = useState("overview"),
    [filter, setFilter] = useState("all"),
    [busy, setBusy] = useState(""),
    [notice, setNotice] = useState(null),
    [confirm, setConfirm] = useState(null),
    [dialogError, setDialogError] = useState(null),
    [ready, setReady] = useState(false);
  const [local, setLocal] = useState(null),
    [backups, setBackups] = useState([]),
    [settings, setSettings] = useState({});
  const tell = (text, error = false) => setNotice({ text, error });
  async function run(key, fn, message) {
    if (busy) return;
    if (key === "switch") setDialogError(null);
    setBusy(key);
    try {
      const value = await fn();
      if (message) tell(message);
      return value;
    } catch (e) {
      if (key === "switch") setDialogError(e.message);
      tell(e.message, true);
    } finally {
      setBusy("");
    }
  }
  useEffect(() => {
    setDialogError(null);
  }, [confirm]);
  useEffect(() => {
    let mounted = true;
    const unsubscribe = api.subscribe((value) => {
      if (mounted) setData(value);
    });
    (async () => {
      try {
        const value = await api.load();
        if (mounted) {
          setData(value);
          setReady(true);
        }
        const fresh = await api.refresh();
        if (mounted) setData(fresh);
      } catch (e) {
        if (mounted) tell(e.message, true);
      } finally {
        if (mounted) setReady(true);
      }
    })();
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    let active = true;
    let timer;
    function nextDay() {
      const untilMidnight = 86400000 - ((Date.now() + 8 * 3600000) % 86400000);
      timer = setTimeout(async () => {
        setToday(dayString());
        try {
          const fresh = await api.refresh();
          if (active) setData(fresh);
        } catch (e) {
          if (active) tell(e.message, true);
        }
        if (active) nextDay();
      }, untilMidnight + 50);
    }
    nextDay();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    let active = true;
    if (page === "conversations") {
      setLocal(null);
      api
        .conversations()
        .then((v) => {
          if (active) setLocal(v);
        })
        .catch((e) => {
          if (active) {
            setLocal({ rows: [], error: e.message });
            tell(e.message, true);
          }
        });
    }
    if (page === "settings")
      Promise.all([api.settings(), api.backups()])
        .then(([s, b]) => {
          if (active) {
            setSettings(s);
            setBackups(b);
          }
        })
        .catch((e) => {
          if (active) tell(e.message, true);
        });
    return () => {
      active = false;
    };
  }, [page, data]);
  const accounts = data.accounts,
    selected = accounts.filter((a) => filter === "all" || a.uid === filter),
    title = pages.find((p) => p[0] === page)[1];
  const overviewChoices = [
    ...new Map(
      accounts.flatMap((a) => (a.models || []).map((m) => [m.id, m])),
    ).values(),
  ].sort(
    (a, b) =>
      Number(b.id === defaultOverviewModel) -
        Number(a.id === defaultOverviewModel) || a.id.localeCompare(b.id),
  );
  const overviewModelId = overviewChoices.some((m) => m.id === overviewModel)
    ? overviewModel
    : overviewChoices[0]?.id || defaultOverviewModel;
  const overviewRunning = overviewStarting || data.modelTests?.running;
  const canTestOverview = (id) =>
    accounts.some((a) => a.models?.some((m) => m.id === id && m.canTest));
  async function testOverviewModel(id = overviewModelId) {
    if (overviewRequest.current || overviewRunning || busy) return;
    const items = accounts
      .filter((a) => a.models?.some((m) => m.id === id && m.canTest))
      .map((a) => ({ uid: a.uid, model: id }));
    if (!items.length) return;
    overviewRequest.current = true;
    setOverviewStarting(true);
    try {
      const job = await api.startModelTests(items);
      setOverviewBatch({
        startedAt: job.startedAt,
        model: id,
        uids: items.map((m) => m.uid),
      });
    } catch (e) {
      tell(e.message, true);
    } finally {
      overviewRequest.current = false;
      setOverviewStarting(false);
    }
  }
  function chooseOverviewModel(id) {
    if (
      id === overviewModelId ||
      overviewRunning ||
      busy ||
      !canTestOverview(id)
    )
      return;
    setOverviewModel(id);
    try {
      localStorage.setItem("overview-model", id);
    } catch {}
    testOverviewModel(id);
  }
  async function stopOverviewTest() {
    try {
      await api.cancelModelTests();
    } catch (e) {
      tell(e.message, true);
    }
  }
  async function reorder(uids) {
    if (busy || uids.every((uid, index) => uid === accounts[index]?.uid))
      return;
    await run("order", async () => {
      setData(await api.reorderAccounts(uids));
      setOrderMessage("账号顺序已保存");
    });
  }
  function moveAccount(uid, step) {
    const uids = accounts.map((a) => a.uid);
    const index = uids.indexOf(uid);
    const next = index + step;
    if (next < 0 || next >= uids.length) return;
    [uids[index], uids[next]] = [uids[next], uids[index]];
    reorder(uids);
  }
  function finishDrag() {
    dragUid.current = null;
    setDragging(null);
    setDropTarget(null);
  }
  function dropAccount(event, target) {
    event.preventDefault();
    const source = dragUid.current;
    if (!source || source === target || busy) return finishDrag();
    const bounds = event.currentTarget.getBoundingClientRect();
    const after = event.clientY > bounds.top + bounds.height / 2;
    const uids = accounts.map((a) => a.uid).filter((uid) => uid !== source);
    uids.splice(uids.indexOf(target) + (after ? 1 : 0), 0, source);
    finishDrag();
    reorder(uids);
  }
  async function refresh() {
    await run("refresh", async () => {
      const fresh = await api.refresh();
      setData(fresh);
      const failed = fresh.accounts.filter(
        (a) => Object.keys(a.errors || {}).length,
      );
      tell(
        failed.length
          ? `${failed.length} 个账号有查询失败项，已保留历史数据；请查看具体原因。`
          : `已更新 ${fresh.accounts.length} 个账号的余额、今日已用、模型状态和签到。`,
        !!failed.length,
      );
    });
  }
  async function importAccounts() {
    await run("import", async () => {
      const result = await api.importAccounts();
      if (result.state) {
        setData(result.state);
        tell("账号已导入，可分别用于两个客户端。");
        setData(await api.refresh());
      }
    });
  }
  async function save(client = "workbuddy") {
    await run(
      "save",
      async () => setData(await api.saveDesktop(client)),
      "当前登录已保存到本机。",
    );
  }
  async function exportAccounts(uids = "all") {
    await run("export-accounts", async () => {
      const result = await api.exportAccounts(uids);
      if (result.canceled) return;
      tell(
        `已导出 ${result.count} 个验证有效的账号。${result.skipped.length ? "跳过：" + result.skipped.map((a) => a.name + "（" + a.reason + "）").join("；") : ""}`,
      );
    });
  }
  async function createBackup(client) {
    await run("backup", async () => {
      const result = await api.createBackup(client);
      setBackups(await api.backups());
      tell(`备份完成，共 ${result.files} 个文件。`);
    });
  }
  const headingAction =
    page === "overview" ? (
      <div className="button-row">
        <Button
          disabled={!!busy || !accounts.length}
          icon={<DownloadSimple />}
          onClick={() => exportAccounts()}
        >
          导出全部有效 JSON
        </Button>
        <Button appearance="primary" disabled={!!busy} onClick={importAccounts}>
          导入账号 JSON
        </Button>
      </div>
    ) : !["settings"].includes(page) ? (
      <Select
        aria-label="查看账号"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      >
        <option value="all">全部账号</option>
        {accounts.map((a) => (
          <option value={a.uid} key={a.uid}>
            {a.name}
          </option>
        ))}
      </Select>
    ) : null;
  return (
    <FluentProvider theme={theme}>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand">
            <img src={brandIcon} />
            <div>
              <strong>WorkBuddy</strong>
              <span>WorkBuddy / CodeBuddy</span>
            </div>
          </div>
          <div className="nav-label">工作台</div>
          <nav>
            {pages.map(([id, label, Icon]) => (
              <button
                key={id}
                className={`nav-item ${page === id ? "active" : ""} ${id === "settings" ? "settings-nav" : ""}`}
                aria-current={page === id ? "page" : undefined}
                onClick={() => {
                  setModelFocus("");
                  setPage(id);
                }}
              >
                <Icon size={20} weight={page === id ? "fill" : "regular"} />
                {label}
              </button>
            ))}
          </nav>
          <div className="local-label">
            <ShieldCheck size={17} />
            <span>仅在这台电脑使用</span>
          </div>
        </aside>
        <div className="workspace">
          {page !== "overview" && (
            <header className="topbar">
              <span>
                工作台 <span className="slash">/</span> <strong>{title}</strong>
              </span>
              <div className="toolbar">
                <span className="muted">
                  最近查询{" "}
                  {date(Math.max(0, ...accounts.map((a) => a.balanceAt || 0)))}
                </span>
                <Button
                  icon={<ArrowsClockwise />}
                  disabled={!!busy}
                  onClick={refresh}
                >
                  {busy === "refresh" ? "查询中…" : "刷新数据"}
                </Button>
              </div>
            </header>
          )}
          <main className={page === "overview" ? "overview-page" : undefined}>
            <div className="page-heading">
              <div>
                {page !== "overview" && (
                  <div className="eyebrow">WORKBUDDY / LOCAL</div>
                )}
                <h1>
                  {page === "overview" ? (
                    <>
                      本机账号 <span className="count">{accounts.length}</span>
                    </>
                  ) : (
                    title
                  )}
                </h1>
                {page !== "overview" && (
                  <p>
                    {
                      {
                        overview: "集中查看登录、剩余积分和对话备份。",
                        credits:
                          "按天、账号和模型查看官方消费账单，以及积分包到期时间。",
                        conversations:
                          "从本机数据库只读查看，与你当前的工作保持同步。",
                        models:
                          "手动测试模型回复、查看限流解锁时间和计费倍率。",
                        rewards: "查看今日签到结果、旅行状态和可领取奖励。",
                        settings: "管理官方程序路径、账号导入与本地备份。",
                      }[page]
                    }
                  </p>
                )}
              </div>
              {headingAction}
            </div>
            {data.demo && (
              <div className="demo-label">演示模式 · 以下均为模拟数据</div>
            )}
            {notice && (
              <div className="notice">
                <MessageBar intent={notice.error ? "error" : "success"}>
                  <MessageBarBody>{notice.text}</MessageBarBody>
                  <Button
                    appearance="transparent"
                    size="small"
                    aria-label="关闭提示"
                    icon={<X />}
                    onClick={() => setNotice(null)}
                  />
                </MessageBar>
              </div>
            )}
            {!ready ? (
              <div className="empty">
                <Spinner label="读取本机账号…" />
              </div>
            ) : (
              <>
                {page === "overview" && (
                  <>
                    <div className="account-list-toolbar">
                      <span
                        className="sort-hint"
                        title="拖动手柄调整顺序；也可聚焦手柄后按 Alt + 上下方向键"
                      >
                        <DotsSixVertical size={16} /> 拖动排序
                      </span>
                      <div className="account-refresh">
                        <span title="今日已用按北京时间 00:00 起的全部客户端官方账单统计；解锁时间也为北京时间。">
                          北京时间 ·{" "}
                          {date(
                            Math.max(
                              0,
                              ...accounts.map((a) => a.balanceAt || 0),
                            ),
                          )}{" "}
                          更新
                        </span>
                        <Button
                          size="small"
                          icon={<ArrowsClockwise size={15} />}
                          disabled={!!busy}
                          onClick={refresh}
                        >
                          {busy === "refresh" ? "查询中…" : "刷新数据"}
                        </Button>
                      </div>
                    </div>
                    <section className="account-list" aria-label="本机账号列表">
                      {accounts.length > 0 && (
                        <div className="account-columns">
                          <span>账号</span>
                          <span>剩余积分</span>
                          <span>今日已用</span>
                          <div className="overview-model-controls">
                            <Select
                              size="small"
                              className="overview-model-select"
                              aria-label="主页状态模型"
                              value={overviewModelId}
                              disabled={
                                !!busy ||
                                !!overviewRunning ||
                                !overviewChoices.length
                              }
                              title={`${modelLabel({ id: overviewModelId })}：选择新模型后，各账号立即测试一次；测试可能消耗积分。`}
                              onChange={(e) =>
                                chooseOverviewModel(e.target.value)
                              }
                            >
                              {overviewChoices.length ? (
                                overviewChoices.map((m) => (
                                  <option
                                    key={m.id}
                                    value={m.id}
                                    disabled={!canTestOverview(m.id)}
                                  >
                                    {modelLabel(m)}
                                  </option>
                                ))
                              ) : (
                                <option value={overviewModelId}>
                                  等待模型目录
                                </option>
                              )}
                            </Select>
                            <Button
                              size="small"
                              className="overview-test-button"
                              disabled={
                                !!busy ||
                                overviewStarting ||
                                (data.modelTests?.running
                                  ? data.modelTests.canceled
                                  : !canTestOverview(overviewModelId))
                              }
                              aria-label={
                                overviewRunning
                                  ? "停止主页模型测试"
                                  : "测试所选模型"
                              }
                              title={
                                overviewRunning
                                  ? `已完成 ${data.modelTests?.completed || 0} / ${data.modelTests?.total || 0}，点击停止`
                                  : "全部可测试账号各测一次，可能消耗积分"
                              }
                              onClick={() =>
                                data.modelTests?.running
                                  ? stopOverviewTest()
                                  : testOverviewModel()
                              }
                            >
                              {overviewRunning ? "停止" : "测试"}
                            </Button>
                          </div>
                          <span>切换客户端</span>
                        </div>
                      )}
                      {accounts.length ? (
                        accounts.map((a) => {
                          const parts = a.name.split(" · ");
                          const alias = parts.length > 1 ? parts.at(-1) : null;
                          const label = alias
                            ? parts.slice(0, -1).join(" · ")
                            : a.name;
                          return (
                            <article
                              className={[
                                "account-row",
                                dragging === a.uid ? "dragging" : "",
                                dropTarget?.uid === a.uid
                                  ? "drop-" + dropTarget.side
                                  : "",
                              ]
                                .filter(Boolean)
                                .join(" ")}
                              key={a.uid}
                              data-account={a.uid}
                              onDragOver={(event) => {
                                if (
                                  !dragUid.current ||
                                  dragUid.current === a.uid ||
                                  busy
                                )
                                  return;
                                event.preventDefault();
                                event.dataTransfer.dropEffect = "move";
                                const bounds =
                                  event.currentTarget.getBoundingClientRect();
                                const side =
                                  event.clientY > bounds.top + bounds.height / 2
                                    ? "after"
                                    : "before";
                                if (
                                  dropTarget?.uid !== a.uid ||
                                  dropTarget?.side !== side
                                )
                                  setDropTarget({ uid: a.uid, side });
                              }}
                              onDragLeave={(event) => {
                                if (
                                  !event.currentTarget.contains(
                                    event.relatedTarget,
                                  )
                                )
                                  setDropTarget(null);
                              }}
                              onDrop={(event) => dropAccount(event, a.uid)}
                            >
                              <div className="row-main">
                                <div className="account-name">
                                  <button
                                    className="account-drag-handle"
                                    aria-label={"调整 " + a.name + " 的顺序"}
                                    title="拖动排序 · Alt + ↑ / ↓"
                                    disabled={!!busy}
                                    draggable={!busy}
                                    onDragStart={(event) => {
                                      dragUid.current = a.uid;
                                      setDragging(a.uid);
                                      event.dataTransfer.setData(
                                        "text/plain",
                                        a.uid,
                                      );
                                      event.dataTransfer.effectAllowed = "move";
                                      event.dataTransfer.setDragImage(
                                        event.currentTarget.closest(
                                          ".account-row",
                                        ),
                                        20,
                                        20,
                                      );
                                    }}
                                    onDragEnd={finishDrag}
                                    onKeyDown={(event) => {
                                      if (
                                        event.altKey &&
                                        ["ArrowUp", "ArrowDown"].includes(
                                          event.key,
                                        )
                                      ) {
                                        event.preventDefault();
                                        moveAccount(
                                          a.uid,
                                          event.key === "ArrowUp" ? -1 : 1,
                                        );
                                      }
                                    }}
                                  >
                                    <DotsSixVertical size={18} />
                                  </button>
                                  <div
                                    className="account-identity"
                                    title={[a.name, a.balance?.plan]
                                      .filter(Boolean)
                                      .join(" · ")}
                                  >
                                    <strong>{alias || label}</strong>
                                    {alias && (
                                      <span className="caption">{label}</span>
                                    )}
                                  </div>
                                </div>
                                <div
                                  className="account-amount"
                                  title={
                                    "已用 " +
                                    number(a.balance?.used) +
                                    " / 总额 " +
                                    number(a.balance?.total) +
                                    "；最近积分到期 " +
                                    date(a.expiry?.next)
                                  }
                                >
                                  <strong>
                                    {number(a.balance?.remaining)}
                                  </strong>
                                </div>
                                <TodayUsage value={a.todayUsage} day={today} />
                                <AccountModelStatus
                                  account={a}
                                  modelId={overviewModelId}
                                  job={data.modelTests}
                                  batch={overviewBatch}
                                  onDetails={() => {
                                    setFilter(a.uid);
                                    setModelFocus(overviewModelId);
                                    setPage("models");
                                  }}
                                />
                                <div className="account-actions">
                                  <div className="parallel-actions">
                                    {[
                                      [
                                        "workbuddy",
                                        "WorkBuddy",
                                        a.desktopActive,
                                        a.canSwitchDesktop,
                                      ],
                                      [
                                        "codebuddy",
                                        "CodeBuddy CN",
                                        a.codebuddyActive,
                                        a.canSwitchCodebuddy,
                                      ],
                                    ].map(([id, client, active, canSwitch]) => (
                                      <Button
                                        key={id}
                                        size="small"
                                        className={
                                          active ? "client-active" : undefined
                                        }
                                        icon={
                                          active ? (
                                            <CheckCircle size={14} />
                                          ) : (
                                            <ArrowRight size={14} />
                                          )
                                        }
                                        disabled={
                                          !!busy || active || !canSwitch
                                        }
                                        onClick={() =>
                                          setConfirm({
                                            type: "switch",
                                            client: id,
                                            account: a,
                                          })
                                        }
                                      >
                                        {active
                                          ? client + " 使用中"
                                          : "切换 " + client}
                                      </Button>
                                    ))}
                                  </div>
                                  <Button
                                    appearance="subtle"
                                    size="small"
                                    disabled={!!busy || !a.hasCredential}
                                    icon={<DownloadSimple size={17} />}
                                    aria-label={
                                      "导出 " + a.name + " 的有效 JSON"
                                    }
                                    title="导出有效 JSON"
                                    onClick={() => exportAccounts([a.uid])}
                                  />
                                </div>
                              </div>
                              <Errors account={a} />
                            </article>
                          );
                        })
                      ) : (
                        <Empty>
                          还没有账号。可导入 JSON，或到设置中保存客户端登录。
                        </Empty>
                      )}
                    </section>
                    <div className="visually-hidden" role="status">
                      {orderMessage}
                    </div>
                  </>
                )}
                {page === "credits" && (
                  <Credits accounts={selected} refreshAt={data.now} />
                )}
                {page === "conversations" && (
                  <>
                    <Note>
                      积分是每段对话的累计记录，不是每天的分模型账单。切号后显示的归属账号也不代表原始扣费账号。
                    </Note>
                    {!local ? (
                      <div className="empty">
                        <Spinner label="读取对话…" />
                      </div>
                    ) : local.error ? (
                      <Empty>{local.error}</Empty>
                    ) : (
                      <>
                        <div className="section-heading">
                          <h2>对话记录</h2>
                          <span className="muted">
                            保留 {local.deleted || 0} 条已删除标记，列表不展示
                          </span>
                        </div>
                        <Table
                          headings={[
                            "对话 / 当前归属",
                            "最近模型",
                            "累计积分",
                            "最后活动",
                          ]}
                        >
                          {local.rows
                            .filter((r) => filter === "all" || r.uid === filter)
                            .map((r) => (
                              <tr key={r.id}>
                                <td className="title-cell">
                                  <strong>{r.title || "未命名对话"}</strong>
                                  <span>
                                    {accounts.find((a) => a.uid === r.uid)
                                      ?.name || r.uid?.slice(0, 8)}
                                  </span>
                                </td>
                                <td>{r.model || "—"}</td>
                                <td className="numeric">{number(r.credits)}</td>
                                <td>{date(r.activityAt)}</td>
                              </tr>
                            ))}
                        </Table>
                        {!local.rows.some(
                          (r) => filter === "all" || r.uid === filter,
                        ) && <Empty>该账号没有本机对话记录</Empty>}
                      </>
                    )}
                  </>
                )}
                {page === "models" && (
                  <Models
                    accounts={selected}
                    allAccounts={accounts}
                    showAllAccounts={() => setFilter("all")}
                    job={data.modelTests}
                    initialSearch={modelFocus}
                  />
                )}
                {page === "rewards" && (
                  <Rewards
                    accounts={selected}
                    busy={busy}
                    run={run}
                    onRefresh={async () => setData(await api.refresh())}
                  />
                )}
                {page === "settings" && (
                  <>
                    {[
                      ["workbuddy", "WorkBuddy", "workbuddyExe"],
                      ["codebuddy", "CodeBuddy CN", "codebuddyExe"],
                    ].map(([id, label, key]) => (
                      <section className="settings-section" key={id}>
                        <h2>{label}</h2>
                        <p>
                          保存当前登录，或在完成工作后主动切换、重启此客户端。
                        </p>
                        <div className="setting-line">
                          <Input
                            aria-label={`${label} 程序路径`}
                            readOnly
                            value={settings[key] || `尚未选择 ${label}.exe`}
                          />
                          <Button
                            disabled={!!busy}
                            onClick={() =>
                              run("path", async () =>
                                setSettings(await api.chooseExecutable(key)),
                              )
                            }
                          >
                            选择程序
                          </Button>
                        </div>
                        <div className="button-row">
                          <Button disabled={!!busy} onClick={() => save(id)}>
                            保存 {label} 登录
                          </Button>
                          <Button
                            disabled={!!busy}
                            onClick={() =>
                              setConfirm({ type: "restart", client: id })
                            }
                          >
                            重启 {label}
                          </Button>
                          <Button
                            disabled={!!busy}
                            onClick={() => createBackup(id)}
                          >
                            备份 {label}
                          </Button>
                        </div>
                      </section>
                    ))}
                    <section className="settings-section">
                      <h2>账号 JSON</h2>
                      <p>
                        支持两个客户端共用的国内版账号。导出时校验身份、有效期和官方接口；批量导出会跳过无效账号。
                      </p>
                      <div className="button-row">
                        <Button disabled={!!busy} onClick={importAccounts}>
                          导入账号 JSON
                        </Button>
                        <Button
                          disabled={!!busy || !accounts.length}
                          onClick={() => exportAccounts()}
                        >
                          导出全部有效 JSON
                        </Button>
                      </div>
                      <p className="caption">
                        账号 JSON
                        含完整登录凭据，请保存在私人目录。导出与备份都不改变正在运行的客户端登录。
                      </p>
                    </section>
                    <section className="settings-section">
                      <div className="section-heading">
                        <h2>本地备份</h2>
                        <div className="button-row">
                          <Button
                            appearance="primary"
                            disabled={!!busy}
                            onClick={() => createBackup("all")}
                          >
                            {busy === "backup"
                              ? "正在备份…"
                              : "立即备份两个客户端"}
                          </Button>
                          <Button
                            icon={<FolderOpen />}
                            disabled={!!busy}
                            onClick={() =>
                              run("folder", () => api.open("backups"))
                            }
                          >
                            打开备份目录
                          </Button>
                        </div>
                      </div>
                      <p>
                        备份包含账号快照、会话数据库和记录文件，并附带完整性校验。恢复账号快照只导回本工具，不覆盖客户端登录或本地会话；历史会话的手动恢复方法见使用说明。
                      </p>
                      <Table headings={["备份时间 / 客户端", "内容", "操作"]}>
                        {backups.map((b) => (
                          <tr key={b.name}>
                            <td className="title-cell">
                              <strong>{date(b.at)}</strong>
                              <span>
                                {b.client === "all"
                                  ? "两个客户端"
                                  : b.client === "codebuddy"
                                    ? "CodeBuddy CN"
                                    : "WorkBuddy"}{" "}
                                ·{" "}
                                {b.kind === "manual"
                                  ? "手动备份"
                                  : "切换前备份"}
                              </span>
                            </td>
                            <td>
                              {b.files
                                ? `${b.files} 个文件 · ${number(b.bytes / 1024 / 1024)} MB`
                                : `${b.database ? "数据库 " : ""}${b.login ? "登录快照" : ""}`}
                            </td>
                            <td>
                              <div className="button-row">
                                <Button
                                  size="small"
                                  disabled={!!busy}
                                  onClick={() =>
                                    run("open-backup", () =>
                                      api.openBackup(b.name),
                                    )
                                  }
                                >
                                  打开
                                </Button>
                                <Button
                                  size="small"
                                  disabled={!!busy || !b.verified}
                                  onClick={() =>
                                    run(
                                      "verify-backup",
                                      () => api.verifyBackup(b.name),
                                      "备份完整性校验通过。",
                                    )
                                  }
                                >
                                  校验
                                </Button>
                                <Button
                                  size="small"
                                  disabled={!!busy || !b.accounts}
                                  onClick={() =>
                                    setConfirm({ type: "restore", backup: b })
                                  }
                                >
                                  恢复账号快照
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </Table>
                      {!backups.length && (
                        <Empty>可立即备份，切换前也会自动保存备份</Empty>
                      )}
                    </section>
                    <section className="settings-section">
                      <h2>数据与说明</h2>
                      <p>
                        每 3
                        分钟查询一次官方余额与模型目录。主动更换主页模型或点击测试才请求模型；签到需手动点击。
                      </p>
                      <Button
                        disabled={!!busy}
                        onClick={() =>
                          run(
                            "export",
                            () => api.open("report"),
                            "报告导出操作已完成。",
                          )
                        }
                      >
                        导出积分与模型报告
                      </Button>
                      <p className="caption">
                        导出内容不含登录凭据。本软件仅保存在这台电脑。
                      </p>
                    </section>
                  </>
                )}
              </>
            )}
            {page !== "overview" && (
              <footer>
                WorkBuddy Switch <span>双客户端 · 本机备份 · 官方积分查询</span>
              </footer>
            )}
          </main>
        </div>
        <Dialog
          open={!!confirm}
          onOpenChange={(_, v) => {
            if (!v.open && !busy) setConfirm(null);
          }}
        >
          <DialogSurface>
            <DialogBody>
              <DialogTitle>
                {confirm?.type === "restore"
                  ? "恢复账号快照"
                  : `${confirm?.type === "switch" ? "切换" : "重启"} ${confirm?.client === "codebuddy" ? "CodeBuddy CN" : "WorkBuddy"}${confirm?.type === "switch" ? " 账号" : ""}`}
              </DialogTitle>
              <DialogContent>
                {confirm?.type === "restore" ? (
                  <p>
                    将校验此备份，并重新验证其中的账号快照后导入本工具。同名快照会先备份；两个客户端的当前登录和全部本地会话保持原样。
                  </p>
                ) : confirm?.type === "switch" ? (
                  <>
                    <p>
                      切换到「{confirm.account.name}」会退出并重新启动官方
                      {confirm.client === "codebuddy"
                        ? "CodeBuddy CN"
                        : "WorkBuddy"}
                      。
                    </p>
                    <p>
                      {confirm.client === "codebuddy"
                        ? "请先保存编辑器中的文件、完成当前任务。客户端正常退出后备份本机记录，仅替换加密登录；退出被阻止时会停止切换。"
                        : "当前登录和数据库会先备份；本机对话与自动任务会随当前账号迁移到目标账号，保留对话内容和已有删除标记。"}
                    </p>
                  </>
                ) : (
                  <p>
                    此操作会退出并重新启动官方
                    {confirm?.client === "codebuddy"
                      ? "CodeBuddy CN"
                      : "WorkBuddy"}
                    。请先保存文件并完成正在进行的工作。
                  </p>
                )}
                {busy === "switch" && (
                  <div
                    className="dialog-feedback"
                    role="status"
                    aria-live="polite"
                  >
                    <Spinner
                      size="tiny"
                      label="正在验证登录、检查状态并执行操作，请稍候…"
                    />
                  </div>
                )}
                {dialogError && (
                  <div
                    className="dialog-feedback"
                    role="alert"
                    aria-live="assertive"
                  >
                    <MessageBar intent="error">
                      <MessageBarBody>{dialogError}</MessageBarBody>
                    </MessageBar>
                  </div>
                )}
              </DialogContent>
              <DialogActions>
                <Button disabled={!!busy} onClick={() => setConfirm(null)}>
                  取消
                </Button>
                <Button
                  appearance="primary"
                  disabled={!!busy}
                  onClick={() =>
                    run(
                      "switch",
                      async () => {
                        if (confirm.type === "restore") {
                          const result = await api.restoreBackup(
                            confirm.backup.name,
                          );
                          setData(result.state);
                        } else
                          setData(
                            await (confirm.type === "switch"
                              ? api.switchDesktop(
                                  confirm.account.uid,
                                  confirm.client,
                                )
                              : api.restartDesktop(confirm.client)),
                          );
                        setConfirm(null);
                      },
                      "操作已完成。",
                    )
                  }
                >
                  {busy === "switch"
                    ? "处理中…"
                    : confirm?.type === "restore"
                      ? "校验并导入快照"
                      : confirm?.type === "switch"
                        ? "备份并切换"
                        : "确认重启"}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      </div>
    </FluentProvider>
  );
}
function Credits({ accounts, refreshAt }) {
  const [view, setView] = useState("ledger");
  return (
    <>
      <div className="tabs" role="tablist" aria-label="积分明细视图">
        {[
          ["ledger", "消费账单"],
          ["packages", "积分包与到期"],
        ].map(([id, label]) => (
          <button
            role="tab"
            aria-selected={view === id}
            className={view === id ? "selected" : ""}
            key={id}
            onClick={() => setView(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {view === "ledger" ? (
        <Ledger accounts={accounts} refreshAt={refreshAt} />
      ) : (
        <Packages accounts={accounts} />
      )}
    </>
  );
}
function dayString(offset = 0) {
  return new Date(Date.now() + 8 * 3600000 - offset * 86400000)
    .toISOString()
    .slice(0, 10);
}
function Ledger({ accounts, refreshAt }) {
  const [start, setStart] = useState(dayString(6)),
    [end, setEnd] = useState(dayString());
  const [client, setClient] = useState("all"),
    [search, setSearch] = useState("");
  const [report, setReport] = useState(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [reload, setReload] = useState(0),
    [exporting, setExporting] = useState(false),
    [exportMessage, setExportMessage] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setReport(null);
    setExportMessage("");
    api
      .usage(start, end)
      .then((v) => {
        if (active) setReport(v);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [start, end, reload, refreshAt]);
  const ids = new Set(accounts.map((a) => a.uid));
  const selected = report?.accounts.filter((a) => ids.has(a.uid)) || [];
  const rows = (report?.summary || []).filter(
    (r) =>
      ids.has(r.uid) &&
      (client === "all" || r.client === client) &&
      (r.model + " " + r.account).toLowerCase().includes(search.toLowerCase()),
  );
  const unknown = rows.reduce((n, r) => n + r.unknown, 0);
  const total =
    rows.reduce((n, r) => n + Math.round(r.knownCredits * 1e6), 0) / 1e6;
  const incomplete = selected.some((a) => !a.complete);
  return (
    <>
      <div className="ledger-controls">
        <div className="button-row">
          {[
            [0, "今天"],
            [6, "近 7 天"],
            [29, "近 30 天"],
          ].map(([days, label]) => (
            <Button
              size="small"
              key={days}
              onClick={() => {
                setStart(dayString(days));
                setEnd(dayString());
              }}
            >
              {label}
            </Button>
          ))}
          <label>
            从{" "}
            <input
              aria-label="账单开始日期"
              type="date"
              value={start}
              max={end}
              onChange={(e) => setStart(e.target.value)}
            />
          </label>
          <label>
            至{" "}
            <input
              aria-label="账单结束日期"
              type="date"
              value={end}
              min={start}
              max={dayString()}
              onChange={(e) => setEnd(e.target.value)}
            />
          </label>
        </div>
        <div className="button-row">
          <Select
            aria-label="账单客户端"
            value={client}
            onChange={(e) => setClient(e.target.value)}
          >
            <option value="all">全部客户端</option>
            <option value="WorkBuddy">WorkBuddy</option>
            <option value="CodeBuddyIDE">CodeBuddy CN</option>
          </Select>
          <Input
            aria-label="搜索账单模型"
            placeholder="搜索模型或账号"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button disabled={loading} onClick={() => setReload((n) => n + 1)}>
            重新查询账单
          </Button>
          <Button
            icon={<DownloadSimple />}
            disabled={loading || exporting || !selected.length || incomplete}
            onClick={async () => {
              setExporting(true);
              setExportMessage("");
              try {
                const r = await api.exportUsage(
                  start,
                  end,
                  client,
                  accounts.map((a) => a.uid),
                  search,
                );
                if (!r.canceled)
                  setExportMessage(`已导出 ${r.count} 行每日模型账单。`);
              } catch (e) {
                setExportMessage(e.message);
              } finally {
                setExporting(false);
              }
            }}
          >
            {exporting ? "正在导出…" : "导出账单 CSV"}
          </Button>
        </div>
      </div>
      {error && (
        <div className="warning" role="alert">
          {error}
        </div>
      )}
      {selected
        .filter((a) => a.error)
        .map((a) => (
          <div className="warning" role="alert" key={a.uid}>
            {a.name}：{a.error}。
            {a.at ? `显示 ${date(a.at)} 的历史账单。` : "尚未取得该账号账单。"}
          </div>
        ))}
      {exportMessage && (
        <p role="status" className="caption">
          {exportMessage}
        </p>
      )}
      {loading ? (
        <Empty>
          <Spinner label="正在分页查询官方消费账单…" />
        </Empty>
      ) : (
        report && (
          <>
            <div className="section-heading">
              <h2>
                {incomplete ? "已取得记录中的" : "所选记录的"}消费积分{" "}
                <span className="ledger-total">{number(total)}</span>
              </h2>
              <span className="caption">
                {rows.reduce((n, r) => n + r.requests, 0)} 条账单 · {start} 至{" "}
                {end} · 北京时间{unknown ? ` · ${unknown} 条金额未提供` : ""}
              </span>
            </div>
            <Table
              headings={[
                "日期 / 账号",
                "模型",
                "客户端",
                "账单条数",
                "消费积分",
              ]}
            >
              {rows.map((r) => (
                <tr key={[r.uid, r.day, r.model, r.client].join("/")}>
                  <td className="title-cell">
                    <strong>{r.day}</strong>
                    <span>{r.account}</span>
                  </td>
                  <td>{r.model}</td>
                  <td>
                    {r.client === "CodeBuddyIDE" ? "CodeBuddy CN" : r.client}
                  </td>
                  <td>{r.requests}</td>
                  <td className="numeric">
                    {number(r.credits)}
                    {r.unknown > 0 && (
                      <span className="caption">
                        已知 {number(r.knownCredits)}；{r.unknown} 条金额未提供
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </Table>
            {!rows.length && (
              <Empty>
                {incomplete
                  ? "账单查询未完成，请重试"
                  : "所选日期、账号和模型没有消费账单"}
              </Empty>
            )}
          </>
        )
      )}
      <Note>
        数据来自官方逐条消费账单，按北京时间、扣费账号和模型汇总；包含免费调用与后台请求，服务端记账可能延迟。切号迁移对话不会改变这里的扣费归属。
      </Note>
    </>
  );
}
function Packages({ accounts }) {
  const [tab, setTab] = useState("active");
  const rows = accounts
    .flatMap((a) =>
      (a.packages || []).map((p) => ({ ...p, account: a.name, uid: a.uid })),
    )
    .filter((p) => tab === "all" || p.state === tab);
  return (
    <>
      {accounts.map((a) => (
        <Errors key={a.uid} account={a} />
      ))}
      <div className="tabs" role="tablist" aria-label="积分包分类">
        {[
          ["active", "可用"],
          ["used", "已用完"],
          ["expired", "已到期"],
          ["all", "全部"],
        ].map(([id, label]) => (
          <button
            role="tab"
            aria-selected={id === tab}
            className={id === tab ? "selected" : ""}
            key={id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <Table
        headings={["积分来源 / 账号", "剩余积分", "已用 / 总额", "到期时间"]}
      >
        {rows.map((p) => (
          <tr key={p.uid + p.id}>
            <td className="title-cell">
              <strong>{p.name}</strong>
              <span>{p.account}</span>
            </td>
            <td className="numeric">{number(p.remaining)}</td>
            <td>
              <Usage
                balance={{
                  total: p.total,
                  used:
                    p.total != null && p.remaining != null
                      ? p.total - p.remaining
                      : null,
                }}
              />
            </td>
            <td>{date(p.end)}</td>
          </tr>
        ))}
      </Table>
      {!rows.length && <Empty>此分类没有积分包记录</Empty>}
      <Note>
        此处为积分包当前周期用量；逐日、逐模型消费请切换到「消费账单」。
      </Note>
    </>
  );
}
function Models({
  accounts,
  allAccounts = accounts,
  showAllAccounts,
  job,
  initialSearch = "",
}) {
  const [search, setSearch] = useState(initialSearch);
  const [view, setView] = useState("all"),
    [now, setNow] = useState(Date.now()),
    [requesting, setRequesting] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(timer);
  }, []);
  const labels = {
    unknown: "未取得账号限额",
    limited: "限流中",
    retry: "已到官方恢复时间",
    success: "测试已返回",
    error: "测试失败",
  };
  const priority = (m) =>
    /deepseek[\s_-]*v?4\.1(?:\D|$)/i.test(m.id + " " + m.name) ? 0 : 1;
  const allRows = accounts
    .flatMap((a) =>
      (a.models || []).map((m) => ({
        ...m,
        account: a.name,
        uid: a.uid,
        busyAt: a.busyAt,
        state:
          m.event?.resetAt && m.event.status === 429
            ? m.event.resetAt > now
              ? "limited"
              : "retry"
            : m.state,
      })),
    )
    .sort(
      (a, b) =>
        priority(a) - priority(b) ||
        a.id.localeCompare(b.id) ||
        a.account.localeCompare(b.account),
    );
  const testable = allRows.filter((m) => m.canTest);
  const deepseekTestable = allAccounts.flatMap((a) => {
    const model = a.models?.find(
      (m) => m.id === "deepseek-v4.1-flash" && m.canTest,
    );
    return model ? [{ ...model, uid: a.uid }] : [];
  });
  const running = job?.running || requesting;
  async function test(items) {
    setError("");
    setRequesting(true);
    try {
      await api.startModelTests(
        items.map((m) => ({ uid: m.uid, model: m.id })),
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setRequesting(false);
    }
  }
  async function cancel() {
    try {
      await api.cancelModelTests();
    } catch (e) {
      setError(e.message);
    }
  }
  const rows = allRows.filter(
    (m) =>
      (m.name + " " + m.id + " " + m.account)
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (view === "all" || m.state === view),
  );
  const busyLabels = {
    idle: "空闲",
    normal: "正常",
    busy: "繁忙",
    congested: "拥挤",
    unavailable: "服务暂不可用",
    unknown: "未取得服务状态",
  };
  const remaining = (at) => {
    if (!at || at <= now) return "已到时间，点击测试确认";
    const minutes = Math.ceil((at - now) / 60000);
    return `剩余 ${minutes >= 60 ? Math.floor(minutes / 60) + " 小时 " : ""}${minutes % 60} 分钟`;
  };
  return (
    <>
      <Note>
        DeepSeek 4.1
        优先显示。主动更换主页模型或点击「测试」会调用模型并取得返回；遇到限流时显示官方提供的解锁时间。测试可能消耗积分，打开页面和刷新数据不会自动测试。
      </Note>
      <div className="section-heading">
        <h2>
          模型状态 <span className="count">{rows.length}</span>
        </h2>
        <Input
          aria-label="搜索模型"
          placeholder="搜索模型或账号"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="model-test-toolbar">
        <div className="button-row">
          <Button
            appearance="primary"
            disabled={running || !deepseekTestable.length}
            title="全部账号的 DeepSeek 4.1 Flash，每个账号测试一次"
            onClick={() => {
              showAllAccounts?.();
              setSearch("");
              setView("all");
              test(deepseekTestable);
            }}
          >
            测试 DeepSeek 4.1（{deepseekTestable.length}）
          </Button>
          <Button
            disabled={running || !testable.length}
            onClick={() => test(testable)}
          >
            一键测试所有模型（{testable.length}）
          </Button>
          {job?.running && (
            <Button onClick={cancel} disabled={job.canceled}>
              {job.canceled ? "正在停止…" : "停止测试"}
            </Button>
          )}
          <span className="caption">
            DeepSeek 4.1：全部账号各测一次；全模型：当前所选账号的全部模型。
          </span>
        </div>
        {job && (
          <div className="model-test-progress" role="status" aria-live="polite">
            <div className="button-row">
              {job.running && <Spinner size="tiny" />}
              <strong>
                {job.running
                  ? job.canceled
                    ? "正在停止"
                    : "正在测试"
                  : job.canceled
                    ? "测试已停止"
                    : "测试完成"}{" "}
                · {job.completed} / {job.total}
              </strong>
              <span>
                成功 {job.counts.success} · 限流 {job.counts.limited} · 失败{" "}
                {job.counts.error}
              </span>
            </div>
            {job.running && (
              <ProgressBar
                aria-label="模型测试进度"
                value={job.total ? job.completed / job.total : 0}
              />
            )}
            {job.running && job.active.length > 0 && (
              <span className="caption">
                当前：{job.active.map((m) => m.model).join("、")}
              </span>
            )}
            {job.error && <span className="warning">{job.error}</span>}
          </div>
        )}
        {error && (
          <p className="warning" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="button-row model-filters">
        <Select
          aria-label="模型状态筛选"
          value={view}
          onChange={(e) => setView(e.target.value)}
        >
          <option value="all">全部状态</option>
          <option value="limited">正在限流</option>
          <option value="retry">已到恢复时间</option>
          <option value="unknown">未取得账号限额</option>
          <option value="success">测试已返回</option>
          <option value="error">测试失败</option>
        </Select>
        {search && (
          <Button size="small" onClick={() => setSearch("")}>
            清除模型搜索
          </Button>
        )}
        <span className="caption">
          共 {accounts.reduce((n, a) => n + (a.models?.length || 0), 0)} 项模型
          / 账号 · 时间为北京时间
        </span>
      </div>
      {accounts.map((a) => (
        <React.Fragment key={a.uid}>
          <Errors account={a} />
          {a.limitsError && (
            <p className="warning">
              {a.name}：{a.limitsError}
            </p>
          )}
        </React.Fragment>
      ))}
      <Table
        headings={[
          "模型 / 账号",
          "服务状态",
          "账号限流",
          "解锁时间 / 剩余",
          "实际返回",
          "计费倍率",
          "手动测试",
        ]}
      >
        {rows.map((m) => (
          <tr
            key={m.uid + m.id}
            data-model={m.id}
            data-account={m.uid}
            className={priority(m) === 0 ? "model-priority" : ""}
          >
            <td className="model-title-cell">
              <strong>{m.name}</strong>
              <span className="caption">
                {m.account} · {m.line || m.id}
              </span>
              {m.name !== m.id && <span className="caption">{m.id}</span>}
            </td>
            <td>
              <span
                className={
                  m.busy === "unavailable" || m.busy === "congested"
                    ? "badge amber"
                    : "record-label"
                }
              >
                {busyLabels[m.busy] || busyLabels.unknown}
              </span>
              <span className="caption">
                {m.busyAt ? date(m.busyAt) + " 查询" : "等待查询"}
              </span>
            </td>
            <td>
              <span
                className={
                  m.state === "limited" ? "badge amber" : "record-label"
                }
              >
                {labels[m.state] || labels.unknown}
              </span>
              {m.event && (
                <span className="caption">
                  {date(m.event.at)} · {m.event.source}
                </span>
              )}
            </td>
            <td>
              {m.event?.resetAt ? (
                <>
                  <time dateTime={new Date(m.event.resetAt).toISOString()}>
                    {new Date(m.event.resetAt).toLocaleString("zh-CN", {
                      timeZone: "Asia/Shanghai",
                      hour12: false,
                    })}
                  </time>
                  <span className="caption">{remaining(m.event.resetAt)}</span>
                </>
              ) : (
                <span className="caption">
                  {m.event?.status >= 200 && m.event?.status < 300
                    ? "本次测试未返回限流"
                    : "官方尚未提供解锁时间"}
                </span>
              )}
            </td>
            <td className="model-response">
              {m.event?.message ? (
                <>
                  <span className="caption">
                    {m.event.httpStatus != null
                      ? `HTTP ${m.event.httpStatus}`
                      : "请求未完成"}
                    {m.event.code != null ? ` · 代码 ${m.event.code}` : ""}
                    {m.event.elapsedMs != null
                      ? ` · ${(m.event.elapsedMs / 1000).toFixed(1)} 秒`
                      : ""}
                  </span>
                  <p>{m.event.message}</p>
                  {m.event.reply && <pre>{m.event.reply}</pre>}
                  {m.event.reasoning && (
                    <details>
                      <summary>返回了思考内容，未返回正文</summary>
                      <pre>{m.event.reasoning}</pre>
                    </details>
                  )}
                </>
              ) : (
                <span className="caption">点击右侧测试，查看实际返回</span>
              )}
            </td>
            <td>{m.credits || "未公布"}</td>
            <td>
              <Button
                size="small"
                aria-label={`测试 ${m.id} · ${m.account}`}
                disabled={running || !m.canTest}
                onClick={() => test([m])}
              >
                {job?.active.some((t) => t.uid === m.uid && t.model === m.id)
                  ? "测试中…"
                  : "测试"}
              </Button>
              {!m.canTest && (
                <span className="caption">需有效登录和官方目录</span>
              )}
            </td>
          </tr>
        ))}
      </Table>
      {!rows.length && <Empty>没有符合条件的模型记录</Empty>}
      <p className="caption model-footnote">
        倍率为官方配置，实际扣费见「积分明细」。服务空闲不代表账号未限流；解锁时间到达后，请手动再次测试确认。每次测试最多输出
        64 tokens、等待 45 秒；不自动重试或切换积分线路。
      </p>
    </>
  );
}
function Rewards({ accounts, busy, run, onRefresh }) {
  const [details, setDetails] = useState({});
  const [destinations, setDestinations] = useState({}),
    [feedback, setFeedback] = useState({});
  const accountKey = accounts.map((a) => a.uid).join("/");
  useEffect(() => {
    let active = true;
    for (const a of accounts.filter((a) => a.hasCredential))
      api
        .extras(a.uid)
        .then((v) => {
          if (active) setDetails((d) => ({ ...d, [a.uid]: v }));
        })
        .catch((e) => {
          if (active) setFeedback((d) => ({ ...d, [a.uid]: e.message }));
        });
    return () => {
      active = false;
    };
  }, [accountKey]);
  async function query(uid) {
    const v = await api.extras(uid);
    setDetails((d) => ({ ...d, [uid]: v }));
  }
  async function action(uid, type, arg) {
    await run("reward", async () => {
      const result = await api.action(uid, type, arg);
      await query(uid);
      await onRefresh();
      setFeedback((d) => ({
        ...d,
        [uid]:
          type === "checkin"
            ? `${result.already ? "今天已签到" : "签到成功"}，官方确认今日获得 ${number(result.credits)} 积分。`
            : "操作完成，状态已重新查询。",
      }));
    });
  }
  return (
    <>
      <Note>
        已配置 GitHub 每日签到，北京时间 08:10、14:10、20:10
        独立执行，启动可能延迟。下方直接查询官方到账状态；手动签到会跳过今天已领取的账号。
      </Note>
      <div className="section-heading">
        <h2>账号福利</h2>
        <Button
          disabled={!!busy || !accounts.some((a) => a.hasCredential)}
          onClick={() =>
            run(
              "checkin-all",
              async () => {
                const failures = [];
                for (const a of accounts.filter((a) => a.hasCredential)) {
                  try {
                    await api.action(a.uid, "checkin");
                  } catch (e) {
                    failures.push(a.name + "：" + e.message);
                  }
                }
                await onRefresh();
                if (failures.length) throw Error(failures.join("；"));
              },
              "当前列表账号签到已提交。",
            )
          }
        >
          全部签到
        </Button>
      </div>
      <div className="reward-list">
        {accounts.map((a) => {
          const value = details[a.uid],
            checkin = value?.checkin || a.checkin,
            travel = value?.travel;
          const checked = checkin?.today_checked_in === true;
          return (
            <section className="reward-row" key={a.uid}>
              <div className="section-heading">
                <div>
                  <h2>{a.name}</h2>
                  <span className="caption">官方签到与旅行奖励</span>
                </div>
                <div className="button-row">
                  <Button
                    disabled={!!busy || !a.hasCredential}
                    onClick={() => run("extras", () => query(a.uid))}
                  >
                    查询福利
                  </Button>
                  <Button
                    appearance="primary"
                    disabled={!!busy || !a.hasCredential || checked}
                    onClick={() => action(a.uid, "checkin")}
                  >
                    {checked ? "今日已签到" : "签到领积分"}
                  </Button>
                  <Button
                    disabled={
                      !!busy ||
                      !a.hasCredential ||
                      !travel ||
                      !!travel.error ||
                      travel.state !== "arrived"
                    }
                    onClick={() => action(a.uid, "claim")}
                  >
                    领取旅行奖励
                  </Button>
                </div>
              </div>
              <div className="reward-status">
                <div>
                  <span className="caption">今日签到</span>
                  <strong>
                    {checkin?.error
                      ? "查询失败"
                      : checked
                        ? `已到账 ${number(checkin.today_credit)} 积分`
                        : checkin
                          ? checkin.active
                            ? "尚未领取"
                            : "活动未开放"
                          : "正在查询…"}
                  </strong>
                  <span className="caption">
                    {checkin?.error ||
                      (checkin ? `连续 ${number(checkin.streak_days)} 天` : "")}
                  </span>
                </div>
                <div>
                  <span className="caption">旅行</span>
                  <strong>
                    {travel?.error
                      ? "查询失败"
                      : {
                          idle: "尚未出发",
                          traveling: "旅行中",
                          arrived: "已返回，可领奖",
                        }[travel?.state] || "正在查询…"}
                  </strong>
                  <span className="caption">
                    {travel?.error ||
                      (travel?.arrive_at
                        ? `返回时间 ${date(travel.arrive_at)}`
                        : travel?.daily_limit_reached
                          ? "今日次数已用完"
                          : "")}
                  </span>
                </div>
                <div>
                  <span className="caption">能量余额</span>
                  <strong>{number(value?.energy?.balance)}</strong>
                  <span className="caption">
                    {value?.energy?.error || "官方查询结果"}
                  </span>
                </div>
              </div>
              {feedback[a.uid] && (
                <p role="status" className="caption">
                  {feedback[a.uid]}
                </p>
              )}
              {travel?.state === "idle" &&
                !travel.daily_limit_reached &&
                value?.destinations?.locations?.length > 0 && (
                  <div className="button-row travel-controls">
                    <Select
                      aria-label={`${a.name} 旅行目的地`}
                      value={
                        destinations[a.uid] ||
                        value.destinations.locations[0].id
                      }
                      onChange={(e) =>
                        setDestinations((d) => ({
                          ...d,
                          [a.uid]: Number(e.target.value),
                        }))
                      }
                    >
                      {value.destinations.locations.map((l) => (
                        <option value={l.id} key={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </Select>
                    <Button
                      disabled={!!busy}
                      onClick={() =>
                        action(
                          a.uid,
                          "depart",
                          destinations[a.uid] ||
                            value.destinations.locations[0].id,
                        )
                      }
                    >
                      开始旅行
                    </Button>
                  </div>
                )}
              {details[a.uid] && (
                <div className="reward-details">
                  {[
                    ["checkin", "签到状态"],
                    ["travel", "旅行状态"],
                    ["energy", "能量"],
                    ["memory", "记忆资料"],
                  ].map(([key, label]) => (
                    <details key={key}>
                      <summary>
                        {label}
                        {details[a.uid][key]?.error ? " · 查询失败" : ""}
                      </summary>
                      <pre>
                        {JSON.stringify(
                          details[a.uid][key] ?? "暂无数据",
                          null,
                          2,
                        )}
                      </pre>
                    </details>
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
      {!accounts.length && <Empty>请先导入或保存账号</Empty>}
    </>
  );
}
createRoot(document.getElementById("root")).render(<App />);
