// Public images always use synthetic data. There is intentionally no live mode.
const { _electron } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");

(async () => {
  const root = path.resolve(__dirname, "..");
  const output = path.join(root, "docs", "images");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "wb-public-demo-"));
  const env = { ...process.env, PW_TEST_SCREENSHOT_NO_FONTS_READY: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await _electron.launch({
      executablePath: require("electron"),
      args: [root, "--demo", "--demo-four", `--user-data-dir=${profile}`],
      cwd: root,
      env,
    });
    const page = await app.firstWindow();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.locator(".account-row").first().waitFor();
    const state = await page.evaluate(() => window.hub.load());
    assert.equal(state.demo, true);
    assert.equal(state.accounts.length, 4);
    assert.ok(state.accounts.every((a) => /^demo-account-\d$/.test(a.uid)));
    assert.ok(
      !/\d{3}\*{2,}\d|eyJ[\w-]+\.[\w-]+\./.test(
        await page.locator("body").innerText(),
      ),
    );
    fs.mkdirSync(output, { recursive: true });
    const images = [];
    const capture = async (name) => {
      await page.bringToFront();
      await page.screenshot({
        path: path.join(output, name),
        animations: "disabled",
        scale: "css",
      });
      images.push(name);
    };
    await capture("overview.png");
    for (const [label, file] of [
      ["积分明细", "credits.png"],
      ["模型记录", "models.png"],
      ["设置与备份", "backups.png"],
    ]) {
      await page.getByRole("button", { name: label, exact: true }).click();
      await page.getByRole("heading", { name: label, exact: true }).waitFor();
      if (label === "积分明细") {
        await page.getByRole("button", { name: "今天", exact: true }).click();
        await page.locator("tbody tr").first().waitFor();
      }
      if (label === "模型记录")
        await page
          .getByRole("textbox", { name: "搜索模型" })
          .fill("deepseek-v4.1");
      if (label === "设置与备份")
        await page
          .locator(".settings-section")
          .filter({
            has: page.getByRole("heading", { name: "本地备份", exact: true }),
          })
          .scrollIntoViewIfNeeded();
      await capture(file);
    }
    await page.getByRole("button", { name: "账号总览", exact: true }).click();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(960, 640),
    );
    await capture("compact.png");
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(output, "source.json"),
      JSON.stringify(
        { source: "DemoBackend", realAccountsRead: false, images },
        null,
        2,
      ) + "\n",
    );
    console.log(JSON.stringify({ ok: true, source: "DemoBackend", images }));
  } finally {
    if (app) await app.close();
    if (!path.resolve(profile).startsWith(path.resolve(os.tmpdir()) + path.sep))
      throw Error("Invalid temporary profile path");
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
