import { chromium } from "playwright";

const BASE = "http://localhost:5105/";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

// 图1：二月三十日 CSV 错误预览
await page.goto(BASE, { waitUntil: "networkidle" });
const seed = {
  version: 1,
  tankTypes: [
    { id: "type-planted", name: "草缸", waterChangeCycleDays: 7, builtin: true,
      ranges: { ph: { min: 6.5, max: 7.5 }, ammonia: { min: 0, max: 0.02 }, nitrite: { min: 0, max: 0.1 }, nitrate: { min: 0, max: 25 }, hardness: { min: 3, max: 12 }, temperature: { min: 22, max: 26 } } },
  ],
  tanks: [{ id: "t1", name: "草缸A", typeId: "type-planted", archived: false, createdAt: "2026-08-01T09:00", note: "" }],
  measurements: [], waterChanges: [], deleted: { measurements: [], waterChanges: [], tanks: [] },
};
await page.evaluate((v) => localStorage.setItem("aq-workbench-data-v1", JSON.stringify(v)), seed);
await page.reload({ waitUntil: "networkidle" });
await page.getByRole("button", { name: "导入导出 / 设置" }).click();
const csv = [
  "鱼缸,时间,pH,氨氮,亚硝酸盐,硝酸盐,硬度GH,温度,备注",
  "草缸A,2026-02-28 09:00,7.0,,,,,,合法一",
  "草缸A,2026-02-30 09:00,7.0,,,,,,幽灵日期",
  "草缸A,2023-02-29 10:00,7.0,,,,,,平年闰日",
  "草缸A,2026-03-01 09:00,7.0,,,,,,合法二",
].join("\n");
await page.locator('input[type=file][data-file=csv]').setInputFiles({ name: "二月测试.csv", mimeType: "text/csv", buffer: Buffer.from(csv, "utf-8") });
await page.waitForTimeout(300);
await page.screenshot({ path: "/tmp/shot-fix-date.png", fullPage: true });

// 图2：缸型段损坏
const broken = structuredClone(seed);
broken.tankTypes = "BROKEN";
await page.evaluate((v) => localStorage.setItem("aq-workbench-data-v1", JSON.stringify(v)), broken);
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(300);
await page.screenshot({ path: "/tmp/shot-fix-types.png", fullPage: true });

// 图3：定向撤销（导入→新增→旧toast撤销）
await page.evaluate((v) => localStorage.setItem("aq-workbench-data-v1", JSON.stringify(v)), seed);
await page.reload({ waitUntil: "networkidle" });
await page.getByRole("button", { name: "导入导出 / 设置" }).click();
const csv2 = [
  "鱼缸,时间,pH,氨氮,亚硝酸盐,硝酸盐,硬度GH,温度,备注",
  "草缸A,2026-09-05 09:00,7.0,,,,,,导入甲",
  "草缸A,2026-09-06 09:00,7.0,,,,,,导入乙",
].join("\n");
await page.locator('input[type=file][data-file=csv]').setInputFiles({ name: "batch.csv", mimeType: "text/csv", buffer: Buffer.from(csv2, "utf-8") });
await page.waitForTimeout(200);
await page.getByRole("button", { name: /导入 2 行/ }).click();
await page.getByRole("button", { name: "检测 / 换水" }).click();
await page.getByRole("button", { name: "＋ 新增检测" }).click();
await page.locator(".metric-input-grid input[type=number]").nth(3).fill("7.7"); // 硝酸盐
await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
await page.waitForTimeout(200);
// 旧导入 toast 仍在（12 秒窗口内），点它
await page.locator(".toast", { hasText: "批量导入" }).getByRole("button", { name: "撤销导入" }).click();
await page.waitForTimeout(200);
await page.screenshot({ path: "/tmp/shot-fix-undo.png", fullPage: true });

await browser.close();
console.log("fix shots done");
