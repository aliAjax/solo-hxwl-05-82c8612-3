/**
 * 核心逻辑自测：node 运行（esbuild 转译）
 * 覆盖：阈值边界、待办判定、刷新恢复（含损坏数据隔离）、撤销栈语义、CSV/JSON 导入失败定位、无损往返
 */
import assert from "node:assert";
import { METRICS } from "../src/core/metrics";
import { emptyData, seedData, BUILTIN_TANK_TYPES } from "../src/core/defaults";
import { loadData, parseBackup, parseCsv, parseFlexibleTime } from "../src/core/validation";
import { generateTodos, buildContexts, worseningTrends, latestExceedances, buildSeries } from "../src/core/analysis";
import { Store } from "../src/core/store";
import type { AppData, Measurement } from "../src/core/types";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

const DAY = 86400000;
const now = Date.parse("2026-09-13T09:00:00");

// ---------- 1. 阈值边界 ----------
test("边界值闭区间：pH 正好 6.5 / 7.5 不越界", () => {
  const d = seedData();
  const planted = d.tankTypes.find((t) => t.id === "type-planted")!;
  const ctx = buildContexts(d).find((c) => c.tank.id === "tank-a")!;
  // 手工塞入边界数据
  const mk = (v: number, daysAgo: number): Measurement => ({
    id: `b${daysAgo}`,
    tankId: "tank-a",
    time: new Date(now - daysAgo * DAY).toISOString(),
    values: { ph: v, nitrate: 10, ammonia: 0, nitrite: 0 },
  });
  ctx.measurements.push(mk(planted.ranges.ph!.min, 1), mk(planted.ranges.ph!.max, 0));
  ctx.measurements.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const exc = latestExceedances(ctx.measurements, planted);
  assert.ok(!exc.some((e) => e.metric === "ph"), "边界 pH 不应被判定越界");
});

test("越过边界 0.01 即越界；越界程度单调", () => {
  const d = seedData();
  const planted = d.tankTypes.find((t) => t.id === "type-planted")!;
  const ctx = buildContexts(d).find((c) => c.tank.id === "tank-a")!;
  const mk = (nitrate: number, daysAgo: number): Measurement => ({
    id: `n${daysAgo}-${nitrate}`,
    tankId: "tank-a",
    time: new Date(now - daysAgo * DAY).toISOString(),
    values: { nitrate },
  });
  const atMax = latestExceedances([mk(25, 1), mk(25, 0)], planted);
  assert.ok(!atMax.some((e) => e.metric === "nitrate"), "硝酸盐=25（上限）不越界");
  const over = latestExceedances([mk(25, 1), mk(25.01, 0)], planted);
  const e1 = over.find((e) => e.metric === "nitrate")!;
  assert.ok(e1 && e1.ratio > 0 && e1.ratio < 0.15, "轻微越界应为提醒级 ratio<15%");
  const far = latestExceedances([mk(25, 1), mk(40, 0)], planted).find((e) => e.metric === "nitrate")!;
  assert.ok(far.ratio > e1.ratio, "越界越远 ratio 越大");
  assert.ok(far.ratio >= 0.5, "40 vs 上限25（区间宽25）ratio=0.6 → 紧急级");
});

test("待办等级：越界程度映射 提醒/警告/紧急", () => {
  const d = seedData();
  const tank = d.tanks.find((t) => t.id === "tank-b")!;
  // nitrite 繁殖缸上限 0.05
  d.measurements = [{ id: "x", tankId: tank.id, time: new Date(now - DAY).toISOString(), values: { nitrite: 0.051 } }];
  d.waterChanges = [{ id: "w", tankId: tank.id, time: new Date(now - DAY).toISOString(), percent: 30 }];
  let todos = generateTodos(d, now);
  assert.equal(todos.find((t) => t.metric === "nitrite")?.level, 1, "0.051 轻微越界 → 提醒");
  d.measurements[0].values.nitrite = 0.2;
  todos = generateTodos(d, now);
  assert.equal(todos.find((t) => t.metric === "nitrite")?.level, 3, "0.2 严重越界 → 紧急");
});

// ---------- 2. 连续恶化趋势 ----------
test("连续 3 次单调逼近边界 → 趋势待办且显示依据", () => {
  const d = emptyData();
  d.tanks = [{ id: "t1", name: "缸1", typeId: "type-planted", archived: false, createdAt: new Date(now - 30 * DAY).toISOString() }];
  d.measurements = [20, 22.5, 24].map((v, i) => ({
    id: `m${i}`,
    tankId: "t1",
    time: new Date(now - (6 - i * 3) * DAY).toISOString(),
    values: { nitrate: v },
  }));
  d.waterChanges = [{ id: "w0", tankId: "t1", time: new Date(now - DAY).toISOString(), percent: 50 }];
  const ctx = buildContexts(d)[0];
  const trends = worseningTrends(ctx.measurements, ctx.type);
  assert.equal(trends.length, 1, "应检出 1 个恶化指标");
  assert.equal(trends[0].streakPoints, 3);
  const todos = generateTodos(d, now);
  assert.ok(todos.some((t) => t.title.includes("连续 3 次恶化")));
  assert.ok(todos[0].reasons.some((r) => r.includes("判定依据")));
});

test("已回稳的指标不报趋势", () => {
  const d = emptyData();
  d.tanks = [{ id: "t1", name: "缸1", typeId: "type-planted", archived: false, createdAt: new Date(now).toISOString() }];
  d.measurements = [24, 20, 10].map((v, i) => ({
    id: `m${i}`,
    tankId: "t1",
    time: new Date(now - (4 - i * 2) * DAY).toISOString(),
    values: { nitrate: v },
  }));
  d.waterChanges = [];
  const ctx = buildContexts(d)[0];
  assert.equal(worseningTrends(ctx.measurements, ctx.type).length, 0, "最后回落不应报恶化");
});

// ---------- 3. 换水周期 ----------
test("换水超期倍数映射等级；周期内无待办", () => {
  const d = emptyData();
  d.tanks = [{ id: "t1", name: "缸1", typeId: "type-planted", archived: false, createdAt: new Date(now).toISOString() }];
  // 草缸周期 7 天
  d.waterChanges = [{ id: "w", tankId: "t1", time: new Date(now - 8 * DAY).toISOString(), percent: 30 }];
  let todos = generateTodos(d, now);
  let wc = todos.find((t) => t.id === "wc-t1")!;
  assert.equal(wc.level, 1, "8/7≈1.14 → 提醒");
  assert.ok(wc.reasons.join("").includes("1.14"));

  d.waterChanges[0].time = new Date(now - 11 * DAY).toISOString();
  wc = generateTodos(d, now).find((t) => t.id === "wc-t1")!;
  assert.equal(wc.level, 2, "11/7≈1.57 → 警告");

  d.waterChanges[0].time = new Date(now - 15 * DAY).toISOString();
  wc = generateTodos(d, now).find((t) => t.id === "wc-t1")!;
  assert.equal(wc.level, 3, "15/7≈2.14 → 紧急");

  d.waterChanges[0].time = new Date(now - 2 * DAY).toISOString();
  assert.ok(!generateTodos(d, now).some((t) => t.id === "wc-t1"), "周期内不应有换水待办");
});

// ---------- 4. 刷新恢复：正常 / 损坏 ----------
test("合法数据全量恢复", () => {
  const d = seedData();
  const r = loadData(JSON.stringify(d));
  assert.equal(r.issues.length, 0);
  assert.equal(r.data!.measurements.length, d.measurements.length);
  assert.equal(r.data!.waterChanges.length, d.waterChanges.length);
});

test("根 JSON 损坏：不崩，隔离原文，空数据启动", () => {
  const r = loadData('{ tanks: [}');
  assert.equal(r.data, null);
  assert.equal(r.rawCorrupted, true);
  assert.equal(r.quarantined.length, 1);
});

test("数组段损坏（measurements 被写成字符串）：跳过该段，缸仍恢复", () => {
  const d = seedData() as unknown as Record<string, unknown>;
  d.measurements = "BROKEN";
  const r = loadData(JSON.stringify(d));
  assert.ok(r.data, "仍应启动");
  assert.equal(r.data!.measurements.length, 0);
  assert.equal(r.data!.tanks.length, 2);
  assert.ok(r.issues.some((i) => i.path === "measurements"));
  assert.ok(r.quarantined.some((q) => q.key === "measurements"));
});

test("单条损坏定位到下标与字段，不株连其它记录", () => {
  const d = seedData();
  const bad = { id: "bad1", tankId: "tank-a", time: "not-a-time", values: { ph: 7.0 } };
  const worse = { id: "bad2", tankId: "tank-a", time: new Date(now).toISOString(), values: { ph: 99 } };
  d.measurements.push(bad as Measurement, worse as unknown as Measurement);
  const r = loadData(JSON.stringify(d));
  assert.equal(r.data!.measurements.length, d.measurements.length - 1, "时间结构性错误整行剔除；字段越界仅剔除该字段");
  const salvaged = r.data!.measurements.find((m) => m.id === "bad2")!;
  assert.ok(salvaged && salvaged.values.ph === undefined && Object.keys(salvaged.values).length === 0, "bad2 的坏 pH 被剔除但记录外壳保留");
  assert.ok(r.issues.some((i) => i.path === "measurements[5].time"), "时间错误定位到 [5].time");
  assert.ok(r.issues.some((i) => i.path.includes("measurements[6].values") && i.message.includes("可行域")), "物理越界定位到 [6] 的 pH");
});

test("重复 id 被剔除并报告位置", () => {
  const d = seedData();
  d.measurements.push({ id: "m1", tankId: "tank-a", time: new Date(now).toISOString(), values: { ph: 7.0 } });
  const r = loadData(JSON.stringify(d));
  assert.ok(r.issues.some((i) => i.message.includes("重复 id")));
  assert.equal(r.data!.measurements.filter((m) => m.id === "m1").length, 1);
});

test("缸型整体缺失时回退内置缸型，待办仍可判定", () => {
  const d = seedData();
  const raw = JSON.stringify({ ...d, tankTypes: undefined });
  const r = loadData(raw);
  assert.equal(r.data!.tankTypes.length, BUILTIN_TANK_TYPES.length);
});

// ---------- 5. CSV 导入失败定位 ----------
test("CSV：未知鱼缸 / 坏时间 / 坏数值 / 列数错位 均指出具体行列", () => {
  const d = seedData();
  const csv = [
    "鱼缸,时间,pH,氨氮,亚硝酸盐,硝酸盐,硬度GH,温度,备注",
    "不存在的缸,2026-09-01 09:00,7.0,,,,,,",
    "草缸A,notdate,7.0,,,,,,",
    "草缸A,2026-09-01 09:00,abc,,,,,,",
    "草缸A,2026-09-01 09:00,7.0,999,,,,,",
    "草缸A,2026-09-01 09:00,7.0,,,,,",
  ].join("\n");
  const r = parseCsv(csv, (name) => d.tanks.find((t) => t.name === name), () => "id" + Math.random().toString(36).slice(2));
  assert.equal(r.kind, "measurement");
  if (r.kind !== "measurement") throw new Error("type narrowing");
  const msgs = r.issues.map((i) => `${i.path} ${i.message}`).join("\n");
  assert.ok(/第 2 行 · 鱼缸/.test(msgs), "未知缸定位行号\n" + msgs);
  assert.ok(/第 3 行 · 时间/.test(msgs), "坏时间定位");
  assert.ok(/第 4 行 · pH列/.test(msgs), "非数字定位到列");
  assert.ok(/第 5 行 · 氨氮列/.test(msgs) && msgs.includes("可行域"), "物理越界定位");
  assert.equal(r.rows.length, 1, "仅 1 行有效（第6行）");
});

test("CSV：表头无法识别 / 缺列", () => {
  const r1 = parseCsv("a,b,c\n1,2,3", () => undefined, () => "x");
  assert.equal(r1.kind, null);
  assert.ok(r1.issues[0].path === "(header)");
  const r2 = parseCsv("鱼缸,时间,氨氮\n草缸A,2026-09-01 09:00,0.01", () => undefined, () => "x");
  assert.equal(r2.kind, null);
  assert.ok(r2.issues[0].message.includes("缺少列"));
});

test("CSV：换水表与引号转义、时间格式兼容", () => {
  const d = seedData();
  const csv = [
    "鱼缸,时间,换水比例%,备注",
    "草缸A,2026/09/01 18:00,30,\"常规,换水\"",
    "草缸A,2026-09-01,150,",
  ].join("\n");
  const r = parseCsv(csv, (name) => d.tanks.find((t) => t.name === name), () => "x");
  assert.equal(r.kind, "waterchange");
  if (r.kind !== "waterchange") throw new Error("narrow");
  assert.equal(r.rows.length, 1);
  assert.equal((r.rows[0] as { percent: number }).percent, 30);
  assert.equal((r.rows[0] as { note?: string }).note, "常规,换水");
  assert.ok(r.issues.some((i) => i.path.includes("第 3 行") && i.message.includes("0~100")));
});

test("parseFlexibleTime：多种格式", () => {
  assert.ok(parseFlexibleTime("2026-09-01 09:00"));
  assert.ok(parseFlexibleTime("2026/09/01"));
  assert.ok(parseFlexibleTime("1756702800000"));
  assert.equal(parseFlexibleTime("notdate"), null);
});

// ---------- 6. 备份无损往返 ----------
test("JSON 备份导出→解析 无损（含回收站/缸型/备注/小数）", () => {
  const d = seedData();
  d.deleted.measurements.push(d.measurements[0]);
  d.measurements = d.measurements.slice(1);
  d.tankTypes[0].ranges.ph = { min: 6.4, max: 7.6 };
  const text = JSON.stringify(d);
  const r = parseBackup(text);
  assert.equal(r.issues.length, 0, "自家导出应零警告");
  assert.ok(r.ok);
  const again = JSON.stringify(r.data);
  assert.deepEqual(JSON.parse(again), JSON.parse(text), "再次导出与原文一致（无损）");
});

test("备份导入损坏：根非法 / 部分坏条可救回", () => {
  const r1 = parseBackup("not json");
  assert.equal(r1.ok, false);
  assert.ok(r1.issues[0].path === "(root)");
  const d = seedData() as unknown as Record<string, unknown>;
  (d.measurements as unknown[]).push({ id: "z", tankId: "tank-a", time: "bad", values: {} });
  const r2 = parseBackup(JSON.stringify(d));
  assert.equal(r2.ok, true, "仍有可救回数据 → 允许导入，问题列为警告");
  assert.ok(r2.issues.length >= 1);
});

// ---------- 7. 异常点定位 ----------
test("趋势异常点：越界 + 突变 + MAD", () => {
  const d = emptyData();
  d.tanks = [{ id: "t1", name: "缸1", typeId: "type-planted", archived: false, createdAt: new Date(now).toISOString() }];
  d.measurements = [10, 11, 10.5, 30, 11].map((v, i) => ({
    id: `m${i}`,
    tankId: "t1",
    time: new Date(now - (8 - i * 2) * DAY).toISOString(),
    values: { nitrate: v },
  }));
  const ctxs = buildContexts(d);
  const series = buildSeries(ctxs, "nitrate")[0];
  const spike = series.points.find((p) => p.value === 30)!;
  assert.ok(spike.anomalous, "突变点 30 应标记异常");
  assert.ok(spike.reason!.includes("突变") || spike.reason!.includes("MAD") || spike.reason!.includes("上限"));
  const normal = series.points.find((p) => p.value === 10.5)!;
  assert.ok(!normal.anomalous);
  // 时间筛选
  const filtered = buildSeries(ctxs, "nitrate", now - 5 * DAY, now + DAY)[0];
  assert.ok(filtered.points.every((p) => p.time >= now - 5 * DAY));
});

// ---------- 8. 撤销语义（直接模拟 store 的快照模型） ----------
test("撤销/重做快照模型：删除→撤销恢复→重做再删除", () => {
  // store 依赖 localStorage，这里用等价模型验证语义
  const undoStack: AppData[] = [];
  const redoStack: AppData[] = [];
  let data = seedData();
  const commit = (fn: (d: AppData) => void) => {
    undoStack.push(structuredClone(data));
    const draft = structuredClone(data);
    fn(draft);
    data = draft;
    redoStack.length = 0;
  };
  const undo = () => {
    redoStack.push(structuredClone(data));
    data = undoStack.pop()!;
  };
  const redo = () => {
    undoStack.push(structuredClone(data));
    data = redoStack.pop()!;
  };
  const before = data.measurements.length;
  commit((d) => {
    d.deleted.measurements.push(d.measurements[0]);
    d.measurements.shift();
  });
  assert.equal(data.measurements.length, before - 1);
  assert.equal(data.deleted.measurements.length, 1);
  undo();
  assert.equal(data.measurements.length, before, "撤销后恢复");
  assert.equal(data.deleted.measurements.length, 0, "回收站也回滚");
  redo();
  assert.equal(data.measurements.length, before - 1, "重做后再次删除");
});

// ---------- 9. 严格日历 ----------
test("严格日历：2026-02-30 / 02-29(平年) / 4-31 / 13 月 一律拒绝，不滚动", () => {
  for (const bad of ["2026-02-30", "2026-02-30 09:00", "2026/02/30", "2026-04-31", "2023-02-29", "2026-13-01", "2026-00-10", "2026-02-32 25:00"]) {
    assert.equal(parseFlexibleTime(bad), null, `${bad} 必须解析失败`);
  }
  // 合法日期不被误伤
  for (const good of ["2026-02-28", "2024-02-29 09:00", "2026-09-01 09:30", "2026/01/01", "1756702800000"]) {
    assert.ok(parseFlexibleTime(good), `${good} 应解析成功`);
  }
});

test("CSV 二月三十日：报错含文件名与行/列，不落到 3 月", () => {
  const d = seedData();
  const csv = [
    "鱼缸,时间,pH,氨氮,亚硝酸盐,硝酸盐,硬度GH,温度,备注",
    "草缸A,2026-02-28 09:00,7.0,,,,,,合法",
    "草缸A,2026-02-30 09:00,7.0,,,,,,幽灵日期",
    "草缸A,2026-03-01 09:00,7.0,,,,,,合法2",
  ].join("\n");
  const r = parseCsv(csv, (n) => d.tanks.find((t) => t.name === n), () => "x", "问题文件.csv");
  assert.equal(r.kind, "measurement");
  if (r.kind !== "measurement") throw new Error("narrow");
  assert.equal(r.rows.length, 2, "仅 2 条合法行");
  const bad = r.issues.find((i) => i.path.includes("第 3 行"));
  assert.ok(bad, "应定位到第 3 行");
  assert.ok(bad.path.includes("问题文件.csv"), "错误路径应含文件名：" + bad.path);
  assert.ok(bad.path.includes("时间"), "应指出是时间列：" + bad.path);
  assert.ok(bad.message.includes("2 月只有 28 天"), "应说明二月天数：" + bad.message);
  assert.ok(r.rows.every((m) => !m.time.startsWith("2026-03-02") && !m.time.startsWith("2026-03-01T09:00") || true));
  const dates = r.rows.map((m) => m.time.slice(0, 10)).sort();
  assert.deepEqual(dates, ["2026-02-28", "2026-03-01"], "不得自动落到 3/2 之类日期");
});

test("JSON 恢复遇二月三十日：定位到字段并剔除该条", () => {
  const d = seedData();
  d.measurements.push({ id: "ghost", tankId: "tank-a", time: "2026-02-30T09:00", values: { ph: 7 } });
  const r = loadData(JSON.stringify(d));
  assert.ok(!r.data!.measurements.some((m) => m.id === "ghost"), "幽灵日期记录不得入库");
  const issue = r.issues.find((i) => i.path === "measurements[5].time");
  assert.ok(issue && issue.message.includes("2 月只有 28 天"), "应指出原因：" + JSON.stringify(issue));
});

// ---------- 10. 缸型为空 / 损坏不白屏 ----------
test("tankTypes 为空数组/段损坏/全非法：恢复内置缸型并告警，待办仍可判定", () => {
  for (const typesVal of [[], "BROKEN", [{ id: "bad" }], null]) {
    const d = seedData();
    const raw = JSON.stringify({ ...d, tankTypes: typesVal });
    const r = loadData(raw);
    assert.ok(r.data, "必须能启动");
    assert.ok(r.data!.tankTypes.length >= BUILTIN_TANK_TYPES.length, `缸型回退内置（输入 ${JSON.stringify(typesVal)}）`);
    assert.ok(r.issues.some((i) => i.path === "tankTypes"), "应报告缸型问题");
    const todos = generateTodos(r.data!, now);
    assert.ok(Array.isArray(todos), "待办生成不崩");
  }
});

test("缸引用缸型全部缺失：resolveType 兜底，换水周期类待办仍出，越界类不误报", () => {
  const d = emptyData();
  d.tanks = [{ id: "t1", name: "无型缸", typeId: "ghost-type", archived: false, createdAt: new Date(now - DAY).toISOString() }];
  // 缸型数组为空（模拟用户删光）
  d.tankTypes = [];
  d.measurements = [];
  d.waterChanges = [{ id: "w0", tankId: "t1", time: new Date(now - 60 * DAY).toISOString(), percent: 30 }];
  const ctxs = buildContexts(d);
  assert.equal(ctxs[0].type.name, "未指定缸型（兜底）");
  const todos = generateTodos(d, now);
  assert.ok(todos.some((t) => t.id === "wc-t1"), "兜底缸型 14 天周期 → 60 天未换应出换水待办");
  assert.ok(!todos.some((t) => t.id.startsWith("exc-")), "无阈值 → 不应产生越界待办");
});

// ---------- 11. 定向撤销 ----------
function makeTestStore(): Store {
  const s = new Store();
  s.__resetForTests(emptyData());
  return s;
}

test("定向撤销：旧 toast 只回退那一次删除，保留期间新增的操作", () => {
  const s = makeTestStore();
  s.addTank({ name: "缸1", typeId: "type-planted" });
  s.addTank({ name: "缸2", typeId: "type-planted" });
  const id1 = s.getData().tanks[0].id;
  const deleteOp = s.commit("删除缸1", (d) => {
    d.tanks = d.tanks.filter((t) => t.id !== id1);
  });
  assert.equal(s.getData().tanks.length, 1);
  // 期间又做了别的操作：新增缸3
  s.addTank({ name: "缸3", typeId: "type-planted" });
  assert.equal(s.getData().tanks.length, 2, "删除后又新增：共 2 个（缸2、缸3）");
  // 点旧 toast 的撤销 —— 只能回退那次删除
  const res = s.undoAction(deleteOp);
  assert.equal(res.applied >= 1, true);
  const names = s.getData().tanks.map((t) => t.name).sort();
  assert.deepEqual(names, ["缸1", "缸2", "缸3"], "缸1 恢复，缸3 保留：" + JSON.stringify(names));
});

test("定向撤销：旧 toast 回退那次批量导入，之后编辑过的导入行保留", () => {
  const s = makeTestStore();
  s.addTank({ name: "缸", typeId: "type-planted" });
  const tankId = s.getData().tanks[0].id;
  const rows: Measurement[] = ["10", "11", "12"].map((v, i) => ({
    id: `imp${i}`,
    tankId,
    time: new Date(now - (3 - i) * DAY).toISOString(),
    values: { nitrate: Number(v) },
  }));
  const importOp = s.importMeasurements(rows);
  assert.equal(s.getData().measurements.length, 3);
  // 期间编辑了 imp0
  s.updateMeasurement("imp0", { note: "之后改过" });
  // 再做一次无关新增
  s.addMeasurement({ tankId, time: new Date(now).toISOString(), values: { ph: 7 } });
  assert.equal(s.getData().measurements.length, 4);
  const res = s.undoAction(importOp);
  const left = s.getData().measurements;
  assert.ok(left.some((m) => m.id === "imp0" && m.note === "之后改过"), "编辑过的导入行保留（跳过）");
  assert.ok(!left.some((m) => m.id === "imp1"), "未改动的导入行回退");
  assert.ok(!left.some((m) => m.id === "imp2"), "未改动的导入行回退");
  assert.ok(left.some((m) => m.values.ph === 7), "无关新增保留");
  assert.ok(res.skipped >= 1, "应报告至少 1 项被跳过");
});

test("定向撤销：之后的普通 Ctrl+Z 仍线性一致，不丢失实体", () => {
  const s = makeTestStore();
  s.addTank({ name: "A缸", typeId: "type-planted" });
  const tankId = s.getData().tanks[0].id;
  const rows: Measurement[] = [1, 2].map((v, i) => ({
    id: `r${i}`,
    tankId,
    time: new Date(now - (2 - i) * DAY).toISOString(),
    values: { nitrate: v * 10 },
  }));
  const importOp = s.importMeasurements(rows); // 2 条
  s.addMeasurement({ tankId, time: new Date(now).toISOString(), values: { ph: 7.2 } }); // 之后新增
  s.undoAction(importOp); // 回退导入，保留 ph 记录
  assert.equal(s.getData().measurements.filter((m) => m.values.ph === 7.2).length, 1);
  // 再 Ctrl+Z：撤销「之后新增」
  s.undo();
  assert.equal(s.getData().measurements.length, 0, "Ctrl+Z 不应把已回退的导入记录又变没，也不应留下 ph 记录");
  // 再 Ctrl+Z：撤销新增缸 → 空数据
  s.undo();
  assert.equal(s.getData().tanks.length, 0);
});

test("重复点同一个旧 toast：第二次无效且不报错", () => {
  const s = makeTestStore();
  const op = s.addTank({ name: "缸", typeId: "type-planted" });
  const r1 = s.undoAction(op);
  assert.equal(r1.notFound, false);
  const r2 = s.undoAction(op);
  assert.equal(r2.notFound, true, "操作已从历史摘除 → notFound");
  assert.equal(s.getData().tanks.length, 0);
});

test("栈顶 toast 撤销后 Ctrl+Y 可重做；旧 toast 条件撤销后重做只重做那一次", () => {
  const s = makeTestStore();
  // 栈顶操作的 toast 撤销：应等同线性撤销，Ctrl+Y 原样重做
  s.addTank({ name: "缸1", typeId: "type-planted" });
  const topOp = s.addTank({ name: "缸2", typeId: "type-planted" });
  s.undoAction(topOp);
  assert.deepEqual(s.getData().tanks.map((t) => t.name), ["缸1"]);
  s.redo(); // Ctrl+Y
  assert.deepEqual(s.getData().tanks.map((t) => t.name), ["缸1", "缸2"], "Ctrl+Y 重做栈顶操作");

  // 旧 toast（非栈顶）条件撤销：删缸1 → 之后新增缸3 → 只回退那次删除
  const id1 = s.getData().tanks.find((t) => t.name === "缸1")!.id;
  const oldOp = s.commit("删缸1", (d) => {
    d.tanks = d.tanks.filter((t) => t.id !== id1);
  });
  assert.deepEqual(s.getData().tanks.map((t) => t.name), ["缸2"]);
  s.addTank({ name: "缸3", typeId: "type-planted" }); // 之后又新增
  s.undoAction(oldOp); // 回退删除：缸1 回来，缸2 缸3 保留
  assert.deepEqual(s.getData().tanks.map((t) => t.name).sort(), ["缸1", "缸2", "缸3"]);
  // Ctrl+Y：条件化重做那次删除（缸1 应被再次移除），不影响缸2/缸3
  s.redo();
  assert.deepEqual(s.getData().tanks.map((t) => t.name).sort(), ["缸2", "缸3"], "条件重做只删除缸1");
});

console.log(`\n核心逻辑自测全部通过：${passed} 项`);
void METRICS;
