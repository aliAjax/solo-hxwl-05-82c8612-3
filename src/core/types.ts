// 核心领域类型定义

/** 指标 key */
export type MetricKey =
  | "ph"
  | "ammonia"
  | "nitrite"
  | "nitrate"
  | "hardness"
  | "temperature";

export interface MetricDef {
  key: MetricKey;
  /** 中文名称 */
  label: string;
  /** 单位 */
  unit: string;
  /** 展示小数位 */
  precision: number;
  /** 录入步进 */
  step: number;
  /** 指标本身的物理可行域（超出即非法数据） */
  physical: { min: number; max: number };
}

/** 缸型（按缸型保存各指标安全区间） */
export interface TankType {
  id: string;
  name: string;
  /** 推荐换水周期（天） */
  waterChangeCycleDays: number;
  /** 各指标安全区间 [min, max]，缺省指标不检测 */
  ranges: Partial<Record<MetricKey, { min: number; max: number }>>;
  builtin?: boolean;
}

export interface Tank {
  id: string;
  name: string;
  typeId: string;
  /** 体积（升），仅备注用 */
  volumeLiters?: number;
  note?: string;
  archived: boolean;
  createdAt: string; // ISO
}

/** 一次水质检测：数值 + 时间 */
export interface Measurement {
  id: string;
  tankId: string;
  time: string; // ISO 或 "YYYY-MM-DDTHH:mm"
  values: Partial<Record<MetricKey, number>>;
  note?: string;
}

/** 一次换水：比例 + 时间 + 备注 */
export interface WaterChange {
  id: string;
  tankId: string;
  time: string; // ISO
  /** 换水比例 0~100（百分比） */
  percent: number;
  note?: string;
}

export interface AppData {
  version: number;
  tankTypes: TankType[];
  tanks: Tank[];
  measurements: Measurement[];
  waterChanges: WaterChange[];
  /** 逻辑删除（导出仍保留完整数据；UI 默认隐藏，可彻底清除） */
  deleted: {
    measurements: Measurement[];
    waterChanges: WaterChange[];
    tanks: Tank[];
  };
}

export const CURRENT_VERSION = 1;

export type Severity = 0 | 1 | 2 | 3; // 0 正常 1 提醒 2 警告 3 紧急

export interface TodoItem {
  id: string;
  tankId: string;
  level: Exclude<Severity, 0>;
  title: string;
  /** 判定依据（结构化，UI 渲染） */
  reasons: string[];
  metric?: MetricKey;
}

/** 单条校验问题（导入/恢复） */
export interface ValidationIssue {
  /** 定位：如 "measurements[3].values.ph" / "第 5 行 · 硝酸盐" */
  path: string;
  message: string;
  value?: unknown;
}

export interface LoadResult {
  data: AppData | null; // 无法挽救时为 null（全新启动）
  issues: ValidationIssue[];
  /** 被隔离的损坏片段（JSON 字符串，供用户下载） */
  quarantined: { key: string; raw: string; error: string }[];
  rawCorrupted: boolean;
}

export interface ImportResult {
  data?: AppData;
  issues: ValidationIssue[];
  imported: {
    tanks: number;
    types: number;
    measurements: number;
    waterChanges: number;
  };
  /** 预览模式：只校验不合并 */
  ok: boolean;
}
