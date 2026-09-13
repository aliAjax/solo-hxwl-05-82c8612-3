import { chromium } from "playwright";

const BASE = "http://localhost:5105/";
const LIBDIRS = process.env.LD_LIBRARY_PATH;
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
await page.addInitScript(() => localStorage.clear());
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(400);

await page.screenshot({ path: "/tmp/shot-1-dashboard.png", fullPage: true });
await page.getByRole("button", { name: "鱼缸与缸型" }).click();
await page.waitForTimeout(200);
await page.screenshot({ path: "/tmp/shot-2-tanks.png", fullPage: true });
await page.getByRole("button", { name: "检测 / 换水" }).click();
await page.waitForTimeout(200);
await page.screenshot({ path: "/tmp/shot-3-records.png", fullPage: true });
await page.getByRole("button", { name: "趋势" }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: "/tmp/shot-4-trends.png", fullPage: true });
await page.getByRole("button", { name: "导入导出 / 设置" }).click();
await page.waitForTimeout(200);
await page.screenshot({ path: "/tmp/shot-5-settings.png", fullPage: true });

// 损坏数据提示横幅：用新页面写入损坏数据后再加载
await ctx.close();
const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page2 = await ctx2.newPage();
await page2.addInitScript(() => localStorage.setItem("aq-workbench-data-v1", '{"tanks":[{"id":"x"}],"measurements":"BROKEN"}'));
await page2.goto(BASE, { waitUntil: "networkidle" });
await page2.waitForTimeout(400);
await page2.screenshot({ path: "/tmp/shot-6-corrupt.png", fullPage: true });

await browser.close();
console.log("shots done");
void LIBDIRS;
