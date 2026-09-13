import type { MetricDef, MetricKey } from "./types";

/** 指标定义（单位/精度/物理可行域） */
export const METRICS: Record<MetricKey, MetricDef> = {
  ph: { key: "ph", label: "pH", unit: "", precision: 2, step: 0.1, physical: { min: 0, max: 14 } },
  ammonia: { key: "ammonia", label: "氨氮", unit: "ppm", precision: 3, step: 0.05, physical: { min: 0, max: 100 } },
  nitrite: { key: "nitrite", label: "亚硝酸盐", unit: "ppm", precision: 3, step: 0.05, physical: { min: 0, max: 100 } },
  nitrate: { key: "nitrate", label: "硝酸盐", unit: "ppm", precision: 1, step: 1, physical: { min: 0, max: 500 } },
  hardness: { key: "hardness", label: "硬度 GH", unit: "dGH", precision: 1, step: 0.5, physical: { min: 0, max: 100 } },
  temperature: { key: "temperature", label: "温度", unit: "℃", precision: 1, step: 0.5, physical: { min: 0, max: 50 } },
};

export const METRIC_KEYS = Object.keys(METRICS) as MetricKey[];

export function formatMetric(key: MetricKey, v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const d = METRICS[key];
  return `${v.toFixed(d.precision)}${d.unit ? " " + d.unit : ""}`;
}

/** 区间状态：0 正常（含边界） 1 超出区间 */
export function outsideRange(v: number, range: { min: number; max: number }): boolean {
  // 边界视为安全（区间为闭区间）
  return v < range.min || v > range.max;
}

/** 越界程度 0~1：刚好在边界为 0，越远离越接近 1（按区间宽度归一） */
export function exceedRatio(v: number, range: { min: number; max: number }): number {
  if (!outsideRange(v, range)) return 0;
  const span = Math.max(range.max - range.min, 1e-9);
  const over = v < range.min ? range.min - v : v - range.max;
  return Math.min(1, over / span);
}
