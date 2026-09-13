import type { AppData, TankType } from "./types";
import { CURRENT_VERSION } from "./types";

/** 内置缸型安全区间（常见经验值，用户可自行编辑/新建） */
export const BUILTIN_TANK_TYPES: TankType[] = [
  {
    id: "type-planted",
    name: "草缸",
    waterChangeCycleDays: 7,
    builtin: true,
    ranges: {
      ph: { min: 6.5, max: 7.5 },
      ammonia: { min: 0, max: 0.02 },
      nitrite: { min: 0, max: 0.1 },
      nitrate: { min: 0, max: 25 },
      hardness: { min: 3, max: 12 },
      temperature: { min: 22, max: 26 },
    },
  },
  {
    id: "type-marine",
    name: "海缸",
    waterChangeCycleDays: 14,
    builtin: true,
    ranges: {
      ph: { min: 8.0, max: 8.4 },
      ammonia: { min: 0, max: 0.02 },
      nitrite: { min: 0, max: 0.1 },
      nitrate: { min: 0, max: 10 },
      hardness: { min: 8, max: 12 },
      temperature: { min: 24, max: 27 },
    },
  },
  {
    id: "type-tanganyika",
    name: "三湖缸",
    waterChangeCycleDays: 7,
    builtin: true,
    ranges: {
      ph: { min: 7.8, max: 9.0 },
      ammonia: { min: 0, max: 0.02 },
      nitrite: { min: 0, max: 0.1 },
      nitrate: { min: 0, max: 20 },
      hardness: { min: 10, max: 25 },
      temperature: { min: 24, max: 28 },
    },
  },
  {
    id: "type-breeding",
    name: "繁殖缸",
    waterChangeCycleDays: 3,
    builtin: true,
    ranges: {
      ph: { min: 6.8, max: 7.4 },
      ammonia: { min: 0, max: 0.01 },
      nitrite: { min: 0, max: 0.05 },
      nitrate: { min: 0, max: 15 },
      hardness: { min: 4, max: 10 },
      temperature: { min: 25, max: 28 },
    },
  },
];

/** 无任何可用缸型（数据为空/全部损坏/被删光）时的运行时兜底，保证页面与判定不白屏 */
export const FALLBACK_TANK_TYPE: TankType = {
  id: "__fallback_type__",
  name: "未指定缸型（兜底）",
  waterChangeCycleDays: 14,
  builtin: true,
  ranges: {}, // 无阈值：不产生越界/趋势待办；换水周期类待办仍可判定
};

export function emptyData(): AppData {
  return {
    version: CURRENT_VERSION,
    tankTypes: BUILTIN_TANK_TYPES.map((t) => structuredClone(t)),
    tanks: [],
    measurements: [],
    waterChanges: [],
    deleted: { measurements: [], waterChanges: [], tanks: [] },
  };
}

/** 首次启动的演示数据（帮助理解；用户可自行删除） */
export function seedData(): AppData {
  const d = emptyData();
  const now = Date.now();
  const iso = (daysAgo: number, h = 9): string =>
    new Date(now - daysAgo * 86400000).toISOString().slice(0, 10) + `T${String(h).padStart(2, "0")}:00`;

  d.tanks = [
    { id: "tank-a", name: "草缸A", typeId: "type-planted", volumeLiters: 60, archived: false, createdAt: iso(60), note: "客厅" },
    { id: "tank-b", name: "繁殖缸C", typeId: "type-breeding", volumeLiters: 30, archived: false, createdAt: iso(30), note: "" },
  ];

  // 草缸A：硝酸盐连续恶化 + 超期未换水
  d.measurements = [
    { id: "m1", tankId: "tank-a", time: iso(21), values: { ph: 6.9, ammonia: 0, nitrite: 0.02, nitrate: 10, temperature: 24.5 } },
    { id: "m2", tankId: "tank-a", time: iso(14), values: { ph: 6.9, ammonia: 0.01, nitrite: 0.03, nitrate: 16, temperature: 24.6 } },
    { id: "m3", tankId: "tank-a", time: iso(7), values: { ph: 7.0, ammonia: 0.01, nitrite: 0.05, nitrate: 22, temperature: 24.4 } },
    { id: "m4", tankId: "tank-a", time: iso(2), values: { ph: 7.1, ammonia: 0.02, nitrite: 0.08, nitrate: 28, temperature: 25.1 } },
    // 繁殖缸C：亚硝酸盐越界
    { id: "m5", tankId: "tank-b", time: iso(5), values: { ph: 7.1, ammonia: 0.02, nitrite: 0.2, nitrate: 12, temperature: 26.5 } },
  ];
  d.waterChanges = [
    { id: "w1", tankId: "tank-a", time: iso(16), percent: 30, note: "常规换水" },
  ];
  return d;
}
