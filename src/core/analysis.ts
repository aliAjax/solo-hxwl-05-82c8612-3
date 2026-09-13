import { METRICS, METRIC_KEYS, exceedRatio, formatMetric, outsideRange } from "./metrics";
import type {
  AppData,
  Measurement,
  MetricKey,
  Severity,
  Tank,
  TankType,
  TodoItem,
} from "./types";

export interface TankContext {
  tank: Tank;
  type: TankType;
  measurements: Measurement[]; // 按时间升序
  waterChanges: AppData["waterChanges"];
}

export function resolveType(data: AppData, tank: Tank): TankType {
  return data.tankTypes.find((t) => t.id === tank.typeId) ?? data.tankTypes[0];
}

export function buildContexts(data: AppData, opts?: { includeArchived?: boolean }): TankContext[] {
  return data.tanks
    .filter((t) => opts?.includeArchived || !t.archived)
    .map((tank) => {
      const type = resolveType(data, tank);
      const measurements = data.measurements
        .filter((m) => m.tankId === tank.id)
        .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
      const waterChanges = data.waterChanges
        .filter((w) => w.tankId === tank.id)
        .sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
      return { tank, type, measurements, waterChanges };
    });
}

/** 连续单调恶化检测：最近连续 N 次（N>=2）同一指标同向变差 */
export interface MetricTrend {
  metric: MetricKey;
  /** 连续恶化次数（数据点个数） */
  streakPoints: number;
  /** 每次平均变化量 */
  deltaPerCheck: number;
  latest: number;
  first: number;
}

function worseDirection(range: { min: number; max: number }, v: number): "high" | "low" {
  // 以离哪个边界近来推断“坏方向”
  return v - range.min > range.max - v ? "high" : "low";
}

export function worseningTrends(m: Measurement[], type: TankType): MetricTrend[] {
  if (m.length < 2) return [];
  const out: MetricTrend[] = [];
  for (const k of METRIC_KEYS) {
    const range = type.ranges[k];
    if (!range) continue;
    const seq: number[] = [];
    const times: number[] = [];
    for (const rec of m) {
      const v = rec.values[k];
      if (typeof v === "number") {
        seq.push(v);
        times.push(Date.parse(rec.time));
      }
    }
    if (seq.length < 2) continue;
    const latest = seq[seq.length - 1];
    // 已经越界，或逼近边界（剩余余量 < 区间宽度的 15%）才认定为有意义的恶化
    const near = outsideRange(latest, range)
      ? true
      : Math.min(latest - range.min, range.max - latest) < (range.max - range.min) * 0.15;
    if (!near) continue;
    const dir = worseDirection(range, latest);
    // 从后往前数连续同向变化
    let streak = 1;
    for (let i = seq.length - 1; i > 0; i--) {
      const d = seq[i] - seq[i - 1];
      const monotonic = dir === "high" ? d > 1e-9 : d < -1e-9;
      if (!monotonic) break;
      streak++;
    }
    if (streak >= 2) {
      const spanDays = Math.max((times[times.length - 1] - times[times.length - streak]) / 86400000, 0.01);
      const totalDelta = latest - seq[seq.length - streak];
      out.push({
        metric: k,
        streakPoints: streak,
        deltaPerCheck: totalDelta / Math.max(spanDays, 1), // 每日变化量（展示用）
        latest,
        first: seq[seq.length - streak],
      });
    }
  }
  return out;
}

export interface Exceedance {
  metric: MetricKey;
  value: number;
  range: { min: number; max: number };
  ratio: number; // 0~1
  side: "high" | "low";
}

export function latestExceedances(m: Measurement[], type: TankType): Exceedance[] {
  if (m.length === 0) return [];
  const last = m[m.length - 1];
  const out: Exceedance[] = [];
  for (const k of METRIC_KEYS) {
    const range = type.ranges[k];
    const v = last.values[k];
    if (!range || typeof v !== "number") continue;
    if (outsideRange(v, range)) {
      out.push({ metric: k, value: v, range, ratio: exceedRatio(v, range), side: v > range.max ? "high" : "low" });
    }
  }
  return out.sort((a, b) => b.ratio - a.ratio);
}

export interface WaterStatus {
  daysSinceLast: number | null;
  cycle: number;
  overdueRatio: number; // 0 = 未超期；>1 越超期
  lastPercent: number | null;
}

export function waterStatus(ctx: TankContext, now: number): WaterStatus {
  const last = ctx.waterChanges[0];
  const days = last ? (now - Date.parse(last.time)) / 86400000 : null;
  return {
    daysSinceLast: days,
    cycle: ctx.type.waterChangeCycleDays,
    overdueRatio: days === null ? Infinity : days / ctx.type.waterChangeCycleDays,
    lastPercent: last ? last.percent : null,
  };
}

function levelName(l: 1 | 2 | 3): string {
  return l === 3 ? "紧急" : l === 2 ? "警告" : "提醒";
}

/**
 * 综合：越界程度 + 连续恶化趋势 + 换水周期 → 维护待办
 */
export function generateTodos(data: AppData, now: number = Date.now()): TodoItem[] {
  const todos: TodoItem[] = [];
  for (const ctx of buildContexts(data)) {
    const { tank, type, measurements } = ctx;
    const tag = `【${tank.name}】`;
    const exc = latestExceedances(measurements, type);
    const trends = worseningTrends(measurements, type);
    const ws = waterStatus(ctx, now);

    // 1) 越界 → 待办，等级随越界程度提升
    for (const e of exc) {
      const def = METRICS[e.metric];
      const level: 1 | 2 | 3 = e.ratio >= 0.5 ? 3 : e.ratio >= 0.15 ? 2 : 1;
      const sideText = e.side === "high" ? `高于安全上限 ${formatMetric(e.metric, e.range.max)}` : `低于安全下限 ${formatMetric(e.metric, e.range.min)}`;
      todos.push({
        id: `exc-${tank.id}-${e.metric}`,
        tankId: tank.id,
        level,
        metric: e.metric,
        title: `${tag}${def.label} ${formatMetric(e.metric, e.value)} 越界`,
        reasons: [
          `判定依据：最近一次检测 ${def.label}=${formatMetric(e.metric, e.value)}，${sideText}（${type.name}安全区间 ${formatMetric(e.metric, e.range.min)} ~ ${formatMetric(e.metric, e.range.max)}）`,
          `越界程度：超出 ${(e.ratio * 100).toFixed(0)}% 区间宽度 → 等级「${levelName(level)}」（≥15% 警告，≥50% 紧急）`,
        ],
      });
    }

    // 2) 连续恶化（尚未越界或已被越界待办覆盖时作为补充理由）
    for (const tr of trends) {
      const def = METRICS[tr.metric];
      const range = type.ranges[tr.metric]!;
      const level: 1 | 2 = tr.streakPoints >= 4 ? 2 : 1;
      const existing = todos.find((t) => t.id === `exc-${tank.id}-${tr.metric}`);
      if (existing) {
        existing.reasons.push(`趋势放大：${def.label}已连续 ${tr.streakPoints} 次检测同向恶化（${formatMetric(tr.metric, tr.first)} → ${formatMetric(tr.metric, tr.latest)}，日均 ${formatMetric(tr.metric, tr.deltaPerCheck)}），建议提高换水频率`);
        // 连续 4 次以上恶化可升级一级
        if (tr.streakPoints >= 4 && existing.level < 3) existing.level = (existing.level + 1) as 2 | 3;
      } else {
        todos.push({
          id: `trend-${tank.id}-${tr.metric}`,
          tankId: tank.id,
          level,
          metric: tr.metric,
          title: `${tag}${def.label}连续 ${tr.streakPoints} 次恶化`,
          reasons: [
            `判定依据：${def.label}最近 ${tr.streakPoints} 次检测连续${tr.latest > tr.first ? "上升" : "下降"}：${formatMetric(tr.metric, tr.first)} → ${formatMetric(tr.metric, tr.latest)}（日均变化 ${formatMetric(tr.metric, tr.deltaPerCheck)}）`,
            `当前值距${type.name}安全区间边界余量不足 15%（区间 ${formatMetric(tr.metric, range.min)} ~ ${formatMetric(tr.metric, range.max)}）→ 预防性换水`,
          ],
        });
      }
    }

    // 3) 换水周期
    if (ws.overdueRatio === Infinity) {
      todos.push({
        id: `wc-${tank.id}`,
        tankId: tank.id,
        level: 1,
        title: `${tag}从无换水记录`,
        reasons: [`判定依据：该缸尚未登记任何换水记录；${type.name}建议换水周期为每 ${ws.cycle} 天一次`],
      });
    } else if (ws.overdueRatio > 1) {
      const days = ws.daysSinceLast!;
      const level: 1 | 2 | 3 = ws.overdueRatio >= 2 ? 3 : ws.overdueRatio >= 1.5 ? 2 : 1;
      todos.push({
        id: `wc-${tank.id}`,
        tankId: tank.id,
        level,
        title: `${tag}已 ${days.toFixed(1)} 天未换水`,
        reasons: [
          `判定依据：距上次换水 ${days.toFixed(1)} 天（上次换 ${ws.lastPercent}%），${type.name}周期 ${ws.cycle} 天`,
          `超期倍数 ${ws.overdueRatio.toFixed(2)}× → 等级「${levelName(level)}」（≥1.5× 警告，≥2× 紧急）`,
        ],
      });
    }
  }
  const rank: Record<number, number> = { 3: 0, 2: 1, 1: 2 };
  return todos.sort((a, b) => rank[a.level] - rank[b.level] || a.tankId.localeCompare(b.tankId));
}

// ---------- 趋势分析 ----------

export interface TrendPoint {
  time: number;
  measurementId: string;
  value: number;
  anomalous: boolean;
  reason?: string;
}

export interface TrendSeries {
  tankId: string;
  metric: MetricKey;
  points: TrendPoint[];
}

/**
 * 异常点定位：
 *  - 超出安全区间
 *  - 相对相邻点突变（变化量 > 区间宽度 40%）
 *  - 相对近邻中位数偏离 > 3× MAD（稳健统计）
 */
export function buildSeries(ctxs: TankContext[], metric: MetricKey, from?: number, to?: number): TrendSeries[] {
  return ctxs.map((ctx) => {
    const range = ctx.type.ranges[metric];
    const recs = ctx.measurements.filter((r) => {
      const t = Date.parse(r.time);
      if (from !== undefined && t < from) return false;
      if (to !== undefined && t > to) return false;
      return typeof r.values[metric] === "number";
    });
    const vals = recs.map((r) => r.values[metric] as number);
    const median = medianOf(vals);
    const mad = medianOf(vals.map((v) => Math.abs(v - median))) || 1e-9;

    const points: TrendPoint[] = recs.map((r, i) => {
      const v = r.values[metric] as number;
      const reasons: string[] = [];
      if (range && outsideRange(v, range)) {
        reasons.push(v > range.max ? `高于上限 ${formatMetric(metric, range.max)}` : `低于下限 ${formatMetric(metric, range.min)}`);
      }
      if (i > 0) {
        const span = range ? Math.max(range.max - range.min, 1e-9) : Math.abs(median) || 1;
        if (Math.abs(v - vals[i - 1]) > span * 0.4) {
          reasons.push(`较上一点突变 ${formatMetric(metric, v - vals[i - 1])}`);
        }
      }
      if (Math.abs(v - median) > 3 * mad) {
        reasons.push(`偏离中位数 ${formatMetric(metric, v - median)}（>3×MAD）`);
      }
      return {
        time: Date.parse(r.time),
        measurementId: r.id,
        value: v,
        anomalous: reasons.length > 0,
        reason: reasons.length ? reasons.join("；") : undefined,
      };
    });
    return { tankId: ctx.tank.id, metric, points };
  });
}

function medianOf(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function severityCount(todos: TodoItem[]): Record<Severity, number> {
  const c: Record<Severity, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const t of todos) c[t.level]++;
  return c;
}
