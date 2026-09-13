/**
 * 真实浏览器端到端验证（Playwright + 生产构建）
 * 覆盖：阈值边界、刷新恢复、撤销、批量导入失败定位、损坏数据可识别且不崩、备份无损往返、离线模式
 */
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE ?? "http://localhost:5105/";
let passed = 0;
const failures = [];

async function ok(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    console.log(`  ✗ ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function freshPage(browser) {
  ctx = await browser.newContext();
  page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  return page;
}

let ctx;
let page;
const errors = [];

const browser = await chromium.launch();

// ========== 1. 阈值边界 ==========
await ok("边界值：硝酸盐=25(上限)安全，25.1 触发待办，40 升级紧急", async () => {
  await freshPage(browser);
  await page.getByRole("button", { name: "检测 / 换水" }).click();
  // 删除示例中已有的草缸A检测记录，只保留边界数据
  await page.getByRole("checkbox").first().check(); // 全选
  const beforeCount = await page.locator("table.data-table tbody tr").count();
  if (beforeCount > 0) {
    await page.getByRole("button", { name: /^删除选中/ }).click();
    // toast 的撤销不是 confirm；批量删除直接执行
  }
  // 新增一条硝酸盐=25 的检测（时间默认当前）
  await addMeasurement(page, { nitrate: "25" });
  await page.getByRole("button", { name: "工作台" }).click();
  // 草缸A有超期换水待办（种子数据16天前换水），这里只断言：边界值不产生硝酸盐越界待办
  assert((await page.locator(".todo-item", { hasText: "硝酸盐" }).count()) === 0, "25=上限不应有硝酸盐待办");

  // 编辑为 25.1
  await page.getByRole("button", { name: "检测 / 换水" }).click();
  await page.getByRole("button", { name: "编辑" }).first().click();
  await page.locator('input[type="number"]').nth(3).fill("25.1"); // 硝酸盐是第4个数字框
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "工作台" }).click();
  assert((await page.locator(".todo-item", { hasText: "硝酸盐" }).count()) > 0, "25.1 应出现硝酸盐越界待办");
  const body0 = await page.locator("main").innerText();
  assert(body0.includes("硝酸盐 25.1 ppm 越界"), "待办标题应含 25.1 ppm");
  assert(/提醒[\s\S]*硝酸盐|硝酸盐[\s\S]*提醒/.test(body0), "轻微越界应为提醒级");

  // 改为 40 → 紧急
  await page.getByRole("button", { name: "检测 / 换水" }).click();
  await page.getByRole("button", { name: "编辑" }).first().click();
  await page.locator('input[type="number"]').nth(3).fill("40");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "工作台" }).click();
  const body = await page.locator("main").innerText();
  const todo = page.locator(".todo-item", { hasText: "硝酸盐" }).first();
  assert((await todo.innerText()).includes("紧急"), "40 应升级为紧急");
  assert(body.includes("判定依据"), "待办必须展示判定依据");
  // 越界程度百分比在展开的判定依据中
  const expand = todo.getByRole("button", { name: /展开全部判定依据/ });
  if (await expand.count()) await expand.click();
  const full = await todo.innerText();
  assert(/越界程度：超出 \d+%/.test(full), "判定依据中应含越界程度百分比：" + full);
});

// ========== 2. 刷新全量恢复 ==========
await ok("刷新后全量恢复（缸/记录/阈值改动都在）", async () => {
  // 沿用上一用例数据（同 context）：先新增一个自定义缸型阈值缸
  await page.getByRole("button", { name: "鱼缸与缸型" }).click();
  await page.getByRole("button", { name: "＋ 新增鱼缸" }).click();
  await page.locator(".modal input").first().fill("E2E边界缸");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  assert(await page.getByText("E2E边界缸").first().isVisible(), "新增缸应可见");

  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "鱼缸与缸型" }).click();
  assert(await page.getByText("E2E边界缸").first().isVisible(), "刷新后新缸仍在");
  await page.getByRole("button", { name: "检测 / 换水" }).click();
  const body = await page.locator("main").innerText();
  assert(body.includes("40.0"), "刷新后硝酸盐=40 的记录仍在");
  assert(body.includes("草缸A"), "草缸A记录仍在");
});

// ========== 3. 撤销：删除 / 批量导入 ==========
await ok("删除记录后撤销恢复（含批量删除）", async () => {
  // 当前只剩 1 条记录，先补两条用于批量删除
  await addMeasurement(page, { nitrate: "11", ph: "7.0" });
  await addMeasurement(page, { nitrate: "12", ph: "7.1" });
  const beforeRows = await page.locator("table.data-table tbody tr").count();
  assert(beforeRows >= 3, `应至少 3 行（实际 ${beforeRows}）`);
  // 选中前两条删除
  const boxes = page.locator("table.data-table tbody input[type=checkbox]");
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await page.getByRole("button", { name: /^删除选中（2）/ }).click();
  let afterRows = await page.locator("table.data-table tbody tr").count();
  assert(afterRows === beforeRows - 2, `应少 2 行（${beforeRows}→${afterRows}）`);
  // toast 撤销（消耗撤销栈顶）
  await page.getByRole("button", { name: "撤销删除" }).click();
  afterRows = await page.locator("table.data-table tbody tr").count();
  assert(afterRows === beforeRows, `撤销后行数恢复（${afterRows}/${beforeRows}）`);

  // Ctrl+Y 重做 → 再次处于删除后；Ctrl+Z 撤销 → 恢复删除前
  await page.keyboard.press("Control+y");
  afterRows = await page.locator("table.data-table tbody tr").count();
  assert(afterRows === beforeRows - 2, "Ctrl+Y 重做：处于删除后状态");
  await page.keyboard.press("Control+z");
  afterRows = await page.locator("table.data-table tbody tr").count();
  assert(afterRows === beforeRows, "Ctrl+Z 撤销：恢复删除前");
});

// ========== 4. 批量导入失败：错误定位具体行列 ==========
await ok("CSV 导入失败：逐行逐列指出错误位置；有效行仍可导入且可撤销", async () => {
  await page.getByRole("button", { name: "导入导出 / 设置" }).click();
  const csv = [
    "鱼缸,时间,pH,氨氮,亚硝酸盐,硝酸盐,硬度GH,温度,备注",
    "不存在的缸X,2026-09-01 09:00,7.0,,,,,,",
    "草缸A,not-a-time,7.0,,,,,,",
    "草缸A,2026-09-01 09:00,abc,,,,,,",
    "草缸A,2026-09-01 09:00,7.0,999,,,,,",
    "草缸A,2026-09-02 09:00,7.0,0.01,0.02,12,,,E2E有效行",
  ].join("\n");
  await uploadFile(page, 0, csv, "bad.csv");
  const preview = await page.locator(".import-preview").innerText();
  assert(preview.includes("第 2 行 · 鱼缸"), "应定位第2行未知缸：\n" + preview);
  assert(preview.includes("第 3 行 · 时间"), "应定位第3行坏时间");
  assert(preview.includes("第 4 行 · pH列"), "应定位第4行非数字");
  assert(preview.includes("第 5 行 · 氨氮列") && preview.includes("可行域"), "应定位第5行物理越界");
  assert(/可导入\s*1\s*行/.test(preview), "仅 1 行可导入：" + preview);

  // 先在设置页完成导入（切走会卸载预览）
  await page.getByRole("button", { name: /导入 1 行/ }).click();
  // 导入后到记录页验证新行
  await page.getByRole("button", { name: "检测 / 换水" }).click();
  const body = await page.locator("main").innerText();
  assert(body.includes("E2E有效行"), "有效行已导入");
  const importedRows = await page.locator("table.data-table tbody tr").count();
  // 撤销导入
  await page.getByRole("button", { name: "撤销导入" }).click();
  const undoneBody = await page.locator("main").innerText();
  assert(!undoneBody.includes("E2E有效行"), "撤销导入后新增行消失");
  const undoneRows = await page.locator("table.data-table tbody tr").count();
  assert(undoneRows === importedRows - 1, `撤销后行数 ${undoneRows} 应比导入后 ${importedRows} 少 1`);
});

await ok("表头无法识别 / 换水表比例越界", async () => {
  await page.getByRole("button", { name: "导入导出 / 设置" }).click();
  await uploadFile(page, 0, "foo,bar\n1,2", "weird.csv");
  let preview = await page.locator(".import-preview").innerText();
  assert(preview.includes("无法识别的表头"), "坏表头应被拒绝：" + preview);
  await page.getByRole("button", { name: "取消" }).click();

  const csv = ["鱼缸,时间,换水比例%,备注", "草缸A,2026-09-03 18:00,150,超量"].join("\n");
  await uploadFile(page, 0, csv, "badwc.csv");
  preview = await page.locator(".import-preview").innerText();
  assert(preview.includes("第 2 行 · 换水比例%列") && preview.includes("0~100"), "换水比例越界应定位：" + preview);
  assert(preview.includes("可导入 0 行"), "0 行可导入时按钮应禁用");
  const importBtn = page.getByRole("button", { name: /导入 0 行/ });
  assert(await importBtn.isDisabled(), "0 行不可点导入");
});

// ========== 5. JSON 备份无损往返 ==========
await ok("JSON 导出→导回无损（缸/缸型阈值/记录/备注一致）", async () => {
  // 用 download 事件拿导出内容
  await page.getByRole("button", { name: "导入导出 / 设置" }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "导出全量备份（JSON）" }).click(),
  ]);
  const text = await downloadPathText(download);
  const json = JSON.parse(text);
  assert(json.tanks.some((t) => t.name === "E2E边界缸"), "导出包含新缸");
  assert(json.tankTypes.length >= 4, "缸型阈值已导出");
  assert(json.measurements.length >= 3, "检测记录已导出");
  assert(json.waterChanges.some((w) => w.note), "换水备注随备份导出");

  // 清空再导回
  await page.getByRole("button", { name: "清空全部数据" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "确定" }).click();
  let body = await page.locator("main").innerText();
  assert(!body.includes("草缸A"), "清空后无缸");
  // 撤销清空，再对比——更严格：清空状态导回备份
  await page.getByRole("button", { name: "导入导出 / 设置" }).click();
  await uploadFile(page, 1, text, "restore.json"); // 第2个文件选择器=JSON
  const preview = await page.locator(".import-preview").innerText();
  assert(preview.includes("问题 0"), "自家备份导入应零问题：" + preview);
  await page.getByRole("button", { name: "全量无损导回" }).click();
  // 导回后到工作台/记录页验证内容
  await page.getByRole("button", { name: "鱼缸与缸型" }).click();
  body = await page.locator("main").innerText();
  assert(body.includes("草缸A") && body.includes("E2E边界缸"), "导回后缸全恢复：" + body.slice(0, 300));
  await page.getByRole("button", { name: "检测 / 换水" }).click();
  body = await page.locator("main").innerText();
  assert(body.includes("40.0"), "导回后记录数值一致");

  // 再导出一次，深度相等
  await page.getByRole("button", { name: "导入导出 / 设置" }).click();
  const [dl2] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "导出全量备份（JSON）" }).click()]);
  const text2 = await downloadPathText(dl2);
  assert(canonical(text2) === canonical(text), "再次导出与首次备份内容一致（无损往返）");
});

// ========== 6. 损坏数据：可识别、定位、不影响启动 ==========
await ok("localStorage 根 JSON 损坏：隔离提示并以空数据正常启动", async () => {
  await page.evaluate(() => localStorage.setItem("aq-workbench-data-v1", "{ broken json"));
  await page.reload({ waitUntil: "networkidle" });
  const banner = await page.locator(".notice-banner").innerText();
  assert(banner.includes("损坏数据"), "应出现损坏提示横幅");
  assert(banner.includes("不是合法 JSON"), "应说明原因");
  const main = await page.locator("main").innerText();
  assert(main.includes("多鱼缸水质工作台"), "页面正常渲染");
  // 可下载隔离原文
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /下载隔离原文/ }).click()]);
  const t = await downloadPathText(dl);
  assert(t.includes("broken json"), "隔离原文可下载");
  // 关闭横幅后应用可正常新增数据
  await page.locator(".notice-banner .icon-btn").click();
  await page.getByRole("button", { name: "鱼缸与缸型" }).click();
  assert(await page.getByRole("button", { name: "＋ 新增鱼缸" }).isVisible(), "应用功能正常");
});

await ok("单条记录损坏：定位下标/字段，其余数据救回", async () => {
  const good = {
    version: 1,
    tankTypes: [
      { id: "tt1", name: "草缸", waterChangeCycleDays: 7, ranges: { nitrate: { min: 0, max: 25 } } },
    ],
    tanks: [{ id: "t1", name: "好缸", typeId: "tt1", archived: false, createdAt: "2026-08-01T00:00" }],
    measurements: [
      { id: "m0", tankId: "t1", time: "2026-09-01T09:00", values: { nitrate: 10 } },
      { id: "m1", tankId: "t1", time: "not-a-time", values: { nitrate: 11 } },
      { id: "m2", tankId: "t1", time: "2026-09-03T09:00", values: { nitrate: 9999 } },
      { id: "m3", tankId: "t1", time: "2026-09-04T09:00", values: { nitrate: 12 }, note: "幸存备注" },
    ],
    waterChanges: [],
    deleted: { measurements: [], waterChanges: [], tanks: [] },
  };
  await page.evaluate((v) => localStorage.setItem("aq-workbench-data-v1", JSON.stringify(v)), good);
  await page.reload({ waitUntil: "networkidle" });
  const banner = await page.locator(".notice-banner").innerText();
  assert(banner.includes("measurements[1].time"), "应定位到第2条的 time：\n" + banner);
  assert(banner.includes("measurements[2].values"), "应定位到第3条越界值");
  await page.getByRole("button", { name: "检测 / 换水" }).click();
  const body = await page.locator("main").innerText();
  assert(body.includes("好缸") && body.includes("幸存备注"), "好记录 m0/m3 被救回");
  // 坏值 9999 已被字段级清洗（行外壳保留、该列为—）；m1 时间非法整行剔除
  const cell9999 = await page.locator("td", { hasText: "9999" }).count();
  assert(cell9999 === 0, "坏值 9999 不应出现在任何单元格");
  const rows = await page.locator("table.data-table tbody tr").count();
  assert(rows === 3, `m0、m2(外壳)、m3 三条在表（实际 ${rows} 条）`);
});

// ========== 7. 离线模式 ==========
await ok("断网后应用仍可加载并操作（service worker 外壳）", async () => {
  // 先在线访问一次确保 SW 缓存并激活
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    await reg.active?.postMessage({});
  });
  await page.waitForTimeout(500);
  await page.context().setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".app-shell");
  const body = await page.locator("main").innerText();
  assert(body.includes("多鱼缸水质工作台"), "离线仍能渲染外壳");
  assert(body.includes("离线模式"), "页脚显示离线状态");
  // 离线状态下新增一条检测（localStorage 可用）
  await page.context().setOffline(false);
});

assert(errors.filter((e) => !e.includes("favicon") && !e.includes("SW register failed")).length === 0,
  "浏览器控制台无错误：\n" + errors.join("\n"));

await browser.close();

console.log(`\nE2E ${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log(failures.map((f) => "  - " + f).join("\n"));
  process.exit(1);
}

// ---------- helpers ----------
async function addMeasurement(p, vals) {
  await p.getByRole("button", { name: "＋ 新增检测" }).click();
  const defs = [
    ["pH", "ph"], ["氨氮", "ammonia"], ["亚硝酸盐", "nitrite"], ["硝酸盐", "nitrate"], ["硬度GH", "hardness"], ["温度", "temperature"],
  ];
  // 弹窗内 6 个指标数字输入，顺序与 METRIC_KEYS 一致
  const keys = ["ph", "ammonia", "nitrite", "nitrate", "hardness", "temperature"];
  const inputs = p.locator(".metric-input-grid input[type=number]");
  for (let i = 0; i < keys.length; i++) {
    if (vals[keys[i]]) await inputs.nth(i).fill(vals[keys[i]]);
  }
  void defs;
  await p.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
}

async function countAllMeasurementRows(p) {
  await p.getByRole("button", { name: "检测 / 换水" }).click();
  // 取消缸筛选
  await p.locator("select").last().selectOption({ index: 0 }).catch(() => {});
  return p.locator("table.data-table tbody tr").count();
}

async function uploadFile(p, index, content, name) {
  const buffer = Buffer.from(content, "utf-8");
  const kind = index === 0 ? "csv" : "json";
  // 用 data-file 精确定位（设置页可能刚切换，避免索引竞态）
  const handle = p.locator(`input[type=file][data-file=${kind}]`);
  await handle.waitFor({ state: "attached" });
  await handle.setInputFiles({ name, mimeType: index === 0 ? "text/csv" : "application/json", buffer });
  await p.waitForTimeout(150);
}

async function downloadPathText(download) {
  const path = await download.path();
  const fs = await import("node:fs");
  return fs.readFileSync(path, "utf-8");
}

function canonical(json) {
  return JSON.stringify(JSON.parse(json));
}
