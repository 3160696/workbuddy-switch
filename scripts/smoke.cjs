const { _electron: electron } = require("playwright");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  assert = require("node:assert/strict");
(async () => {
  const exe = process.argv[2];
  const env = { ...process.env, PW_TEST_SCREENSHOT_NO_FONTS_READY: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "wb-ui-demo-"));
  const app = await electron.launch({
    executablePath: exe || require("electron"),
    args: [...(exe ? [] : ["."]), "--demo", `--user-data-dir=${profile}`],
    cwd: process.cwd(),
    env,
  });
  try {
    const page = await app.firstWindow(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.getByRole("heading", { name: /^本机账号/ }).waitFor();
    await page.locator(".account-row").first().waitFor();
    assert.equal(await page.locator(".account-row").count(), 3);
    assert.deepEqual(
      await page.locator(".account-name strong").allTextContents(),
      ["buddy1", "buddy2", "buddy3"],
    );
    assert.equal(
      await page.locator(".client-panels, .summary-strip").count(),
      0,
    );
    assert.deepEqual(
      await page.locator(".today-usage strong").allTextContents(),
      ["36", "38", "40"],
    );
    assert.equal(await page.getByText("今日已用", { exact: true }).count(), 1);
    const demoState = await page.evaluate(() => window.hub.load());
    const accountIds = () =>
      page
        .locator(".account-row")
        .evaluateAll((rows) => rows.map((row) => row.dataset.account));
    const originalOrder = demoState.accounts.map((a) => a.uid);
    const lastBounds = await page.locator(".account-row").last().boundingBox();
    await page
      .locator(".account-drag-handle")
      .first()
      .dragTo(page.locator(".account-row").last(), {
        targetPosition: { x: 50, y: lastBounds.height - 5 },
      });
    await page.waitForFunction(
      () =>
        document.querySelector(".account-row:last-child")?.dataset.account ===
        "demo-account-0",
    );
    assert.deepEqual(await accountIds(), [
      "demo-account-1",
      "demo-account-2",
      "demo-account-0",
    ]);
    await page.getByRole("button", { name: "刷新数据", exact: true }).click();
    assert.deepEqual(await accountIds(), [
      "demo-account-1",
      "demo-account-2",
      "demo-account-0",
    ]);
    await page.locator(".account-drag-handle").last().press("Alt+ArrowUp");
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".account-row")][1]?.dataset.account ===
        "demo-account-0",
    );
    assert.deepEqual(await accountIds(), [
      "demo-account-1",
      "demo-account-0",
      "demo-account-2",
    ]);
    await page.evaluate(
      (uids) => window.hub.reorderAccounts(uids),
      originalOrder,
    );
    await page.waitForFunction(
      () =>
        document.querySelector(".account-row")?.dataset.account ===
        "demo-account-0",
    );
    if (
      await page.getByRole("button", { name: "关闭提示", exact: true }).count()
    )
      await page.getByRole("button", { name: "关闭提示", exact: true }).click();
    const publishDaily = async (value) => {
      const state = structuredClone(demoState);
      state.accounts[0].todayUsage = value;
      await app.evaluate(({ BrowserWindow }, state) => {
        BrowserWindow.getAllWindows()[0].webContents.send("hub:state", state);
      }, state);
    };
    const daily = demoState.accounts[0].todayUsage;
    const firstDaily = page.locator(".today-usage").first();
    await publishDaily({ ...daily, credits: 0 });
    await firstDaily.getByText("0", { exact: true }).waitFor();
    await publishDaily({
      ...daily,
      credits: null,
      at: null,
      complete: false,
      error: "offline",
    });
    await firstDaily.getByText("查询失败", { exact: true }).waitFor();
    assert.equal(await firstDaily.locator("strong").innerText(), "—");
    await publishDaily({ ...daily, complete: false, error: "offline" });
    await firstDaily.getByText("未更新", { exact: true }).waitFor();
    assert.equal(await firstDaily.locator("strong").innerText(), "36");
    await publishDaily({ ...daily, day: "2020-01-01" });
    await firstDaily.getByText("等待查询", { exact: true }).waitFor();
    assert.equal(await firstDaily.locator("strong").innerText(), "—");
    await publishDaily(daily);
    assert.equal(await page.locator(".account-deepseek").count(), 3);
    assert.deepEqual(
      await page.locator(".account-deepseek .badge").allTextContents(),
      ["尚未测试", "限流中", "尚未测试"],
    );
    const firstDeepseek = page.locator(".account-deepseek").first();
    const publishDeepseek = async (event) => {
      const state = structuredClone(demoState);
      state.accounts[0].models.find(
        (m) => m.id === "deepseek-v4.1-flash",
      ).event = event;
      await app.evaluate(({ BrowserWindow }, state) => {
        BrowserWindow.getAllWindows()[0].webContents.send("hub:state", state);
      }, state);
    };
    const observation = {
      at: Date.now(),
      status: 429,
      resetAt: Date.now() + 3 * 3600000,
    };
    await publishDeepseek(observation);
    await firstDeepseek.getByText("限流中", { exact: true }).waitFor();
    assert.equal(
      await firstDeepseek.locator("time").getAttribute("datetime"),
      new Date(observation.resetAt).toISOString(),
    );
    assert.match(await firstDeepseek.innerText(), /剩余/);
    await publishDeepseek({ ...observation, resetAt: Date.now() - 60000 });
    await firstDeepseek.getByText("已到恢复时间", { exact: true }).waitFor();
    await firstDeepseek.getByText("请手动测试确认", { exact: true }).waitFor();
    await publishDeepseek({ ...observation, resetAt: null });
    await firstDeepseek
      .getByText("官方尚未提供解锁时间", { exact: true })
      .waitFor();
    assert.equal(await firstDeepseek.locator("time").count(), 0);
    // A successful result supersedes an old deadline; failure/unknown must not
    // invent a deadline or claim that the model is available.
    await publishDeepseek({ ...observation, status: 200 });
    await firstDeepseek.getByText("最近测试成功", { exact: true }).waitFor();
    assert.equal(await firstDeepseek.locator("time").count(), 0);
    await publishDeepseek({ ...observation, status: 0 });
    await firstDeepseek.getByText("最近测试失败", { exact: true }).waitFor();
    assert.equal(await firstDeepseek.locator("time").count(), 0);
    await publishDeepseek(null);
    await firstDeepseek.getByText("尚未测试", { exact: true }).waitFor();
    await page
      .locator('.account-deepseek[data-account="demo-account-1"]')
      .getByRole("button", { name: "查看 / 测试", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "模型记录", exact: true })
      .waitFor();
    assert.equal(
      await page.getByRole("combobox", { name: "查看账号" }).inputValue(),
      "demo-account-1",
    );
    assert.equal(await page.locator(".model-test-progress").count(), 0);
    await page.getByRole("combobox", { name: "查看账号" }).selectOption("all");
    await page.getByRole("button", { name: "账号总览", exact: true }).click();
    await page.getByRole("button", { name: "刷新数据", exact: true }).click();
    await page.getByRole("button", { name: "刷新数据", exact: true }).waitFor();
    await page
      .getByRole("button", { name: "切换 WorkBuddy", exact: true })
      .first()
      .click();
    await page
      .getByRole("heading", { name: "切换 WorkBuddy 账号", exact: true })
      .waitFor();
    // Exercise the actual confirmation path using DemoBackend only. Previously
    // rejected operations put their error behind this modal and looked inert.
    await page.getByRole("button", { name: "备份并切换", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("alert")
      .filter({ hasText: "演示模式不切换真实账号" })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "备份并切换", exact: true })
        .isEnabled(),
      true,
    );
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page
      .getByRole("button", { name: "切换 CodeBuddy CN", exact: true })
      .first()
      .click();
    await page
      .getByRole("heading", { name: "切换 CodeBuddy CN 账号", exact: true })
      .waitFor();
    assert.equal(await page.getByRole("dialog").getByRole("alert").count(), 0);
    await page.getByRole("button", { name: "备份并切换", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("alert")
      .filter({ hasText: "演示模式不切换真实账号" })
      .waitFor();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "关闭提示", exact: true }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    const output = path.resolve("artifacts/demo");
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({
      path: path.join(output, "overview.png"),
      animations: "disabled",
      scale: "css",
    });
    for (const name of [
      "积分明细",
      "本机对话",
      "模型记录",
      "签到与福利",
      "设置与备份",
    ]) {
      await page.getByRole("button", { name, exact: true }).click();
      await page.getByRole("heading", { name, exact: true }).waitFor();
      if (name === "积分明细") {
        await page.getByRole("button", { name: "今天", exact: true }).click();
        await page
          .getByText("deepseek-v4.1-flash", { exact: true })
          .first()
          .waitFor();
        await page
          .getByRole("combobox", { name: "账单客户端" })
          .selectOption("CodeBuddyIDE");
        assert.equal(await page.locator("tbody tr").count(), 3);
        await page
          .getByRole("combobox", { name: "查看账号" })
          .selectOption("demo-account-0");
        assert.equal(await page.locator("tbody tr").count(), 1);
        await page
          .getByRole("combobox", { name: "查看账号" })
          .selectOption("all");
        await page
          .getByRole("combobox", { name: "账单客户端" })
          .selectOption("all");
        await page.screenshot({
          path: path.join(output, "消费账单.png"),
          animations: "disabled",
          scale: "css",
        });
        await page
          .getByRole("tab", { name: "积分包与到期", exact: true })
          .click();
        await page.locator("tbody tr").first().waitFor();
        await page.getByRole("tab", { name: "全部", exact: true }).click();
      }
      if (name === "本机对话") {
        await page
          .getByText("整理项目资料与会议记录", { exact: true })
          .waitFor();
        assert.equal(await page.locator("tbody tr").count(), 3);
        await page
          .getByRole("combobox", { name: "查看账号" })
          .selectOption("demo-account-0");
        await page
          .getByText("该账号没有本机对话记录", { exact: true })
          .waitFor();
        await page
          .getByRole("combobox", { name: "查看账号" })
          .selectOption("all");
      }
      if (name === "模型记录") {
        assert.deepEqual(
          await page
            .locator("select[aria-label='查看账号'] option")
            .allTextContents(),
          [
            "全部账号",
            "个人账号 · buddy1",
            "工作账号 · buddy2",
            "备用账号 · buddy3",
          ],
        );
        await page.getByRole("textbox", { name: "搜索模型" }).fill("buddy2");
        assert.equal(await page.locator("tbody tr").count(), 4);
        await page
          .getByRole("button", { name: "清除模型搜索", exact: true })
          .click();
        assert.deepEqual(
          await page
            .locator("tbody tr")
            .evaluateAll((rows) =>
              rows.slice(0, 3).map((r) => r.dataset.model),
            ),
          Array(3).fill("deepseek-v4.1-flash"),
        );
        assert.equal(await page.locator(".model-test-progress").count(), 0);
        await page
          .getByRole("combobox", { name: "模型状态筛选" })
          .selectOption("limited");
        assert.equal(await page.locator("tbody tr").count(), 1);
        await page.getByText(/剩余 2 小时/).waitFor();
        await page
          .getByRole("combobox", { name: "模型状态筛选" })
          .selectOption("all");
        await page.getByRole("textbox", { name: "搜索模型" }).fill("glm");
        assert.equal(await page.locator("tbody tr").count(), 3);
        await page
          .getByRole("button", { name: "清除模型搜索", exact: true })
          .click();
        assert.equal(await page.locator("tbody tr").count(), 12);
        await page
          .getByRole("button", {
            name: "测试 deepseek-v4.1-flash · 工作账号 · buddy2",
            exact: true,
          })
          .click();
        await page
          .locator(".model-test-progress")
          .filter({ hasText: /测试完成.*1 \/ 1/ })
          .waitFor();
        const limited = page.locator(
          'tr[data-account="demo-account-1"][data-model="deepseek-v4.1-flash"]',
        );
        await limited.getByText(/超出频率限制/).waitFor();
        assert.match(await limited.locator("time").innerText(), /12:49:03/);
        assert.match(await limited.innerText(), /HTTP 429/);
        await page
          .getByRole("combobox", { name: "查看账号" })
          .selectOption("demo-account-0");
        await page.getByRole("textbox", { name: "搜索模型" }).fill("glm");
        // All-model testing follows the selected account, regardless of search.
        await page
          .getByRole("button", { name: "一键测试所有模型（4）", exact: true })
          .click();
        await page
          .locator(".model-test-progress")
          .filter({ hasText: /测试完成.*4 \/ 4/ })
          .waitFor();
        await page
          .getByRole("button", { name: "清除模型搜索", exact: true })
          .click();
        assert.equal(await page.locator(".model-response pre").count(), 4);
        assert.match(
          await page.locator(".model-test-progress").innerText(),
          /成功 4/,
        );
        await page
          .getByRole("combobox", { name: "查看账号" })
          .selectOption("all");
        await page
          .getByRole("button", { name: "一键测试所有模型（12）", exact: true })
          .click();
        await page
          .getByRole("button", { name: "停止测试", exact: true })
          .click();
        await page
          .locator(".model-test-progress")
          .filter({ hasText: "测试已停止" })
          .waitFor();
        await page
          .getByRole("button", { name: "一键测试所有模型（12）", exact: true })
          .click();
        await page
          .locator(".model-test-progress")
          .filter({ hasText: /测试完成.*12 \/ 12/ })
          .waitFor();
        assert.match(
          await page.locator(".model-test-progress").innerText(),
          /成功 11.*限流 1/,
        );
        // The focused shortcut tests each account's 4.1 Flash exactly once,
        // even when a different account/model/status is currently selected.
        await page
          .getByRole("combobox", { name: "查看账号" })
          .selectOption("demo-account-0");
        await page.getByRole("textbox", { name: "搜索模型" }).fill("glm");
        await page
          .getByRole("combobox", { name: "模型状态筛选" })
          .selectOption("limited");
        await page
          .getByRole("button", { name: "测试 DeepSeek 4.1（3）", exact: true })
          .click();
        await page
          .locator(".model-test-progress")
          .filter({ hasText: /测试完成.*3 \/ 3/ })
          .waitFor();
        assert.equal(
          await page.getByRole("combobox", { name: "查看账号" }).inputValue(),
          "all",
        );
        assert.equal(
          await page.getByRole("textbox", { name: "搜索模型" }).inputValue(),
          "",
        );
        assert.equal(
          await page
            .getByRole("combobox", { name: "模型状态筛选" })
            .inputValue(),
          "all",
        );
        const focusedJob = await page.evaluate(() =>
          window.hub.load().then((state) => state.modelTests),
        );
        assert.equal(focusedJob.total, 3);
        assert.equal(focusedJob.completed, 3);
        assert.deepEqual(focusedJob.counts, {
          success: 2,
          limited: 1,
          error: 0,
        });
      }
      if (name === "签到与福利") {
        await page
          .getByRole("button", { name: "查询福利", exact: true })
          .first()
          .click();
        await page.getByText("签到状态", { exact: true }).first().waitFor();
        await page
          .getByText("已到账 100 积分", { exact: true })
          .first()
          .waitFor();
        assert.equal(
          await page
            .getByRole("button", { name: "今日已签到", exact: true })
            .first()
            .isEnabled(),
          false,
        );
      }
      if (name === "设置与备份") {
        await page
          .getByRole("button", { name: "重启 WorkBuddy", exact: true })
          .click();
        await page
          .getByRole("button", { name: "确认重启", exact: true })
          .waitFor();
        await page.getByRole("button", { name: "取消", exact: true }).click();
        await page
          .getByRole("button", { name: "重启 CodeBuddy CN", exact: true })
          .click();
        await page
          .getByRole("heading", { name: "重启 CodeBuddy CN", exact: true })
          .waitFor();
        await page.getByRole("button", { name: "取消", exact: true }).click();
        await page
          .getByRole("button", { name: "恢复账号快照", exact: true })
          .click();
        await page
          .getByRole("button", { name: "校验并导入快照", exact: true })
          .waitFor();
        await page.getByRole("button", { name: "取消", exact: true }).click();
      }
      await page.bringToFront();
      await page.screenshot({
        path: path.join(output, `${name}.png`),
        animations: "disabled",
        scale: "css",
      });
    }
    await page.getByRole("button", { name: "账号总览", exact: true }).click();
    const fourState = await page.evaluate(() => window.hub.load());
    fourState.accounts.push({
      ...structuredClone(fourState.accounts[0]),
      uid: "demo-account-3",
      name: "第四账号 · buddy4",
      desktopActive: false,
      codebuddyActive: false,
    });
    await app.evaluate(({ BrowserWindow }, state) => {
      BrowserWindow.getAllWindows()[0].webContents.send("hub:state", state);
    }, fourState);
    await page.getByRole("heading", { name: /^本机账号 4$/ }).waitFor();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(960, 640),
    );
    await page.bringToFront();
    await page.screenshot({
      path: path.join(output, "compact.png"),
      animations: "disabled",
      scale: "css",
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.equal(await page.locator(".today-usage").count(), 4);
    assert.equal(await page.locator(".account-deepseek").count(), 4);
    assert.equal(
      await page.evaluate(
        () =>
          document
            .querySelector(".account-row:last-child")
            .getBoundingClientRect().bottom <= innerHeight,
      ),
      true,
      "All four accounts must fit without scrolling",
    );
    for (const fits of await page
      .locator(".account-deepseek")
      .evaluateAll((rows) =>
        rows.map((row) => row.scrollWidth <= row.clientWidth),
      ))
      assert.equal(fits, true, "DeepSeek status overflows the account row");
    for (const value of await page.locator(".row-main").evaluateAll((rows) =>
      rows.map((row) => {
        const columns = [...row.children].filter(
          (el) => getComputedStyle(el).display !== "none",
        );
        return columns.every(
          (el, index) =>
            !index ||
            columns[index - 1].getBoundingClientRect().right <=
              el.getBoundingClientRect().left + 1,
        );
      }),
    ))
      assert.equal(
        value,
        true,
        "Account columns overlap in the compact layout",
      );
    assert.ok(
      !/magpie|harness|dsh|eyJ[\w-]+\.[\w-]+\./i.test(
        await page.locator("body").innerText(),
      ),
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: synthetic UI, all pages, account filters, dialogs canceled, compact layout; no live client operations",
    );
  } finally {
    await app.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
