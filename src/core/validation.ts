import { METRICS, METRIC_KEYS } from "./metrics";
import { emptyData } from "./defaults";
import type {
  AppData,
  ImportResult,
  LoadResult,
  Measurement,
  MetricKey,
  Tank,
  TankType,
  ValidationIssue,
  WaterChange,
} from "./types";
import { CURRENT_VERSION } from "./types";

const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

export function isValidTime(s: unknown): s is string {
  if (typeof s !== "string" || !s) return false;
  if (isoRe.test(s)) return !Number.isNaN(Date.parse(s));
  return !Number.isNaN(Date.parse(s));
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function issue(path: string, message: string, value?: unknown): ValidationIssue {
  return { path, message, value: value === undefined ? undefined : serializeValue(value) };
}

function serializeValue(v: unknown): unknown {
  if (typeof v === "bigint") return String(v);
  if (v === null || v === undefined) return v;
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return v;
}

function validMetric(k: MetricKey, v: unknown, path: string, issues: ValidationIssue[]): v is number {
  if (!isNum(v)) {
    issues.push(issue(path, "数值必须是数字", v));
    return false;
  }
  const p = METRICS[k].physical;
  if (v < p.min || v > p.max) {
    issues.push(issue(path, `超出物理可行域 ${p.min}~${p.max}${METRICS[k].unit}`, v));
    return false;
  }
  return true;
}

function validateRange(k: MetricKey, r: unknown, path: string, issues: ValidationIssue[]): boolean {
  if (typeof r !== "object" || r === null) {
    issues.push(issue(path, "区间必须是 {min,max} 对象", r));
    return false;
  }
  const { min, max } = r as { min?: unknown; max?: unknown };
  if (!isNum(min) || !isNum(max)) {
    issues.push(issue(path, "区间上下限必须是数字", r));
    return false;
  }
  const p = METRICS[k].physical;
  if (min < p.min || max > p.max) {
    issues.push(issue(path, `区间超出物理可行域 ${p.min}~${p.max}`, r));
    return false;
  }
  if (min > max) {
    issues.push(issue(path, `区间下限 ${min} 大于上限 ${max}`, r));
    return false;
  }
  return true;
}

// ---------- 单条清洗 ----------

function cleanTankType(raw: unknown, path: string, issues: ValidationIssue[]): TankType | null {
  if (typeof raw !== "object" || raw === null) {
    issues.push(issue(path, "缸型必须是对象", raw));
    return null;
  }
  const o = raw as Record<string, unknown>;
  let bad = false;
  if (typeof o.id !== "string" || !o.id) {
    issues.push(issue(`${path}.id`, "缺少 id", o.id));
    bad = true;
  }
  if (typeof o.name !== "string" || !o.name) {
    issues.push(issue(`${path}.name`, "缺少名称", o.name));
    bad = true;
  }
  const cycle = o.waterChangeCycleDays;
  if (!isNum(cycle) || cycle <= 0 || cycle > 365) {
    issues.push(issue(`${path}.waterChangeCycleDays`, "换水周期必须是 0~365 之间的数字（天）", cycle));
    bad = true;
  }
  const ranges: TankType["ranges"] = {};
  if (o.ranges !== undefined && (typeof o.ranges !== "object" || o.ranges === null)) {
    issues.push(issue(`${path}.ranges`, "阈值必须是对象", o.ranges));
  } else if (o.ranges) {
    for (const k of METRIC_KEYS) {
      const r = (o.ranges as Record<string, unknown>)[k];
      if (r !== undefined && validateRange(k, r, `${path}.ranges.${k}`, issues)) {
        const rr = r as { min: number; max: number };
        ranges[k] = { min: rr.min, max: rr.max };
      }
    }
  }
  if (bad) return null;
  return {
    id: String(o.id ?? ""),
    name: String(o.name ?? ""),
    waterChangeCycleDays: isNum(cycle) && cycle > 0 ? cycle : 7,
    ranges,
    builtin: o.builtin === true,
  };
}

function cleanTank(raw: unknown, path: string, issues: ValidationIssue[]): Tank | null {
  if (typeof raw !== "object" || raw === null) {
    issues.push(issue(path, "鱼缸必须是对象", raw));
    return null;
  }
  const o = raw as Record<string, unknown>;
  let bad = false;
  if (typeof o.id !== "string" || !o.id) {
    issues.push(issue(`${path}.id`, "缺少 id", o.id));
    bad = true;
  }
  if (typeof o.name !== "string" || !o.name) {
    issues.push(issue(`${path}.name`, "缺少名称", o.name));
    bad = true;
  }
  if (typeof o.typeId !== "string" || !o.typeId) {
    issues.push(issue(`${path}.typeId`, "缺少缸型 id", o.typeId));
    bad = true;
  }
  if (!isValidTime(o.createdAt)) {
    issues.push(issue(`${path}.createdAt`, "创建时间无法解析", o.createdAt));
    bad = true;
  }
  if (bad) return null;
  return {
    id: o.id as string,
    name: o.name as string,
    typeId: o.typeId as string,
    volumeLiters: isNum(o.volumeLiters) ? (o.volumeLiters as number) : undefined,
    note: typeof o.note === "string" ? o.note : undefined,
    archived: o.archived === true,
    createdAt: o.createdAt as string,
  };
}

function cleanMeasurement(raw: unknown, path: string, issues: ValidationIssue[]): Measurement | null {
  if (typeof raw !== "object" || raw === null) {
    issues.push(issue(path, "检测记录必须是对象", raw));
    return null;
  }
  const o = raw as Record<string, unknown>;
  let bad = false;
  if (typeof o.id !== "string" || !o.id) {
    issues.push(issue(`${path}.id`, "缺少 id", o.id));
    bad = true;
  }
  if (typeof o.tankId !== "string" || !o.tankId) {
    issues.push(issue(`${path}.tankId`, "缺少鱼缸 id", o.tankId));
    bad = true;
  }
  if (!isValidTime(o.time)) {
    issues.push(issue(`${path}.time`, "检测时间无法解析（支持 YYYY-MM-DDTHH:mm 或 YYYY-MM-DD HH:mm）", o.time));
    bad = true;
  }
  const values: Measurement["values"] = {};
  if (typeof o.values !== "object" || o.values === null) {
    issues.push(issue(`${path}.values`, "指标数据必须是对象", o.values));
    bad = true;
  } else {
    for (const k of METRIC_KEYS) {
      const v = (o.values as Record<string, unknown>)[k];
      if (v !== undefined && v !== null && v !== "") {
        if (validMetric(k, v, `${path}.values.${METRICS[k].label}`, issues)) values[k] = v as number;
      }
    }
  }
  if (bad) return null;
  return {
    id: o.id as string,
    tankId: o.tankId as string,
    time: o.time as string,
    values,
    note: typeof o.note === "string" ? o.note : undefined,
  };
}

function cleanWaterChange(raw: unknown, path: string, issues: ValidationIssue[]): WaterChange | null {
  if (typeof raw !== "object" || raw === null) {
    issues.push(issue(path, "换水记录必须是对象", raw));
    return null;
  }
  const o = raw as Record<string, unknown>;
  let bad = false;
  if (typeof o.id !== "string" || !o.id) {
    issues.push(issue(`${path}.id`, "缺少 id", o.id));
    bad = true;
  }
  if (typeof o.tankId !== "string" || !o.tankId) {
    issues.push(issue(`${path}.tankId`, "缺少鱼缸 id", o.tankId));
    bad = true;
  }
  if (!isValidTime(o.time)) {
    issues.push(issue(`${path}.time`, "换水时间无法解析", o.time));
    bad = true;
  }
  if (!isNum(o.percent) || (o.percent as number) <= 0 || (o.percent as number) > 100) {
    issues.push(issue(`${path}.percent`, "换水比例必须是 0~100 之间的数字（%）", o.percent));
    bad = true;
  }
  if (bad) return null;
  return {
    id: o.id as string,
    tankId: o.tankId as string,
    time: o.time as string,
    percent: o.percent as number,
    note: typeof o.note === "string" ? o.note : undefined,
  };
}

type Cleaner<T> = (raw: unknown, path: string, issues: ValidationIssue[]) => T | null;

function cleanArray<T>(raw: unknown, key: string, clean: Cleaner<T>, issues: ValidationIssue[], quarantine: LoadResult["quarantined"]): T[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.push(issue(key, "该字段应为数组，已整体跳过并隔离", raw));
    quarantine.push({ key, raw: safeStringify(raw), error: "not-array" });
    return [];
  }
  const seen = new Set<string>();
  const out: T[] = [];
  raw.forEach((item, i) => {
    const before = issues.length;
    const cleaned = clean(item, `${key}[${i}]`, issues);
    if (!cleaned) return;
    const id = (cleaned as { id?: string }).id;
    if (id !== undefined) {
      if (seen.has(id)) {
        issues.push(issue(`${key}[${i}].id`, `重复 id「${id}」，该条已跳过`, id));
        return;
      }
      seen.add(id);
    }
    void before;
    out.push(cleaned);
  });
  return out;
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ---------- 启动恢复（损坏隔离，不影响启动） ----------

export function loadData(raw: string | null): LoadResult {
  const issues: ValidationIssue[] = [];
  const quarantined: LoadResult["quarantined"] = [];

  if (raw === null || raw.trim() === "") {
    return { data: null, issues, quarantined, rawCorrupted: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    quarantined.push({ key: "(root)", raw, error: e instanceof Error ? e.message : String(e) });
    return {
      data: null,
      issues: [issue("(root)", "存储内容不是合法 JSON，已整体隔离并以空数据启动。可在「设置」中下载损坏原文。")],
      quarantined,
      rawCorrupted: true,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    quarantined.push({ key: "(root)", raw: safeStringify(parsed), error: "root-not-object" });
    return {
      data: null,
      issues: [issue("(root)", "存储根节点不是对象，已整体隔离。", parsed)],
      quarantined,
      rawCorrupted: true,
    };
  }

  const o = parsed as Record<string, unknown>;
  const base = emptyData();

  // 缸型整体缺失（例如该段损坏被置 null）→ 回退内置缸型，保证判定可用
  let types = cleanArray(o.tankTypes, "tankTypes", cleanTankType, issues, quarantined);
  if (types.length === 0 && o.tankTypes === undefined) {
    types = base.tankTypes;
  }

  const tanks = cleanArray(o.tanks, "tanks", cleanTank, issues, quarantined);
  const measurements = cleanArray(o.measurements, "measurements", cleanMeasurement, issues, quarantined);
  const waterChanges = cleanArray(o.waterChanges, "waterChanges", cleanWaterChange, issues, quarantined);

  // 逻辑删除区（同样逐条救回）
  const d = o.deleted;
  let deleted: AppData["deleted"] = { measurements: [], waterChanges: [], tanks: [] };
  if (d !== undefined) {
    if (typeof d !== "object" || d === null) {
      issues.push(issue("deleted", "回收站字段损坏，已跳过", d));
      quarantined.push({ key: "deleted", raw: safeStringify(d), error: "not-object" });
    } else {
      const dd = d as Record<string, unknown>;
      deleted = {
        measurements: cleanArray(dd.measurements, "deleted.measurements", cleanMeasurement, issues, quarantined),
        waterChanges: cleanArray(dd.waterChanges, "deleted.waterChanges", cleanWaterChange, issues, quarantined),
        tanks: cleanArray(dd.tanks, "deleted.tanks", cleanTank, issues, quarantined),
      };
    }
  }

  // 引用完整性：引用不存在缸/缸型的记录保留但告警（重新导入对应缸后即恢复）
  const tankIds = new Set(tanks.map((t) => t.id));
  for (const m of measurements) {
    if (!tankIds.has(m.tankId)) issues.push(issue(`measurements#${m.id}`, `引用了不存在的鱼缸 id「${m.tankId}」，记录已保留`, m.tankId));
  }
  for (const w of waterChanges) {
    if (!tankIds.has(w.tankId)) issues.push(issue(`waterChanges#${w.id}`, `引用了不存在的鱼缸 id「${w.tankId}」，记录已保留`, w.tankId));
  }
  const typeIds = new Set(types.map((t) => t.id));
  for (const t of tanks) {
    if (!typeIds.has(t.typeId)) issues.push(issue(`tanks#${t.id}`, `引用了不存在的缸型 id「${t.typeId}」，已回退到第一个可用缸型`, t.typeId));
  }

  return {
    data: { version: CURRENT_VERSION, tankTypes: types, tanks, measurements, waterChanges, deleted },
    issues,
    quarantined,
    rawCorrupted: quarantined.length > 0,
  };
}

// ---------- JSON 备份导入（可无损导回） ----------

export function parseBackup(text: string): ImportResult {
  const issues: ValidationIssue[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return {
      issues: [issue("(root)", `不是合法 JSON：${e instanceof Error ? e.message : String(e)}`)],
      imported: { tanks: 0, types: 0, measurements: 0, waterChanges: 0 },
      ok: false,
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { issues: [issue("(root)", "根节点必须是对象")], imported: { tanks: 0, types: 0, measurements: 0, waterChanges: 0 }, ok: false };
  }
  const o = parsed as Record<string, unknown>;
  const quarantine: LoadResult["quarantined"] = [];
  const tankTypes = cleanArray(o.tankTypes, "tankTypes", cleanTankType, issues, quarantine);
  const tanks = cleanArray(o.tanks, "tanks", cleanTank, issues, quarantine);
  const measurements = cleanArray(o.measurements, "measurements", cleanMeasurement, issues, quarantine);
  const waterChanges = cleanArray(o.waterChanges, "waterChanges", cleanWaterChange, issues, quarantine);
  let deleted: AppData["deleted"] = { measurements: [], waterChanges: [], tanks: [] };
  if (o.deleted !== undefined && typeof o.deleted === "object" && o.deleted !== null) {
    const dd = o.deleted as Record<string, unknown>;
    deleted = {
      measurements: cleanArray(dd.measurements, "deleted.measurements", cleanMeasurement, issues, quarantine),
      waterChanges: cleanArray(dd.waterChanges, "deleted.waterChanges", cleanWaterChange, issues, quarantine),
      tanks: cleanArray(dd.tanks, "deleted.tanks", cleanTank, issues, quarantine),
    };
  }
  const total = tanks.length + measurements.length + waterChanges.length + tankTypes.length;
  return {
    data: { version: CURRENT_VERSION, tankTypes, tanks, measurements, waterChanges, deleted },
    issues,
    imported: {
      tanks: tanks.length,
      types: tankTypes.length,
      measurements: measurements.length,
      waterChanges: waterChanges.length,
    },
    // JSON 根合法且至少救回一条数据 → 可导入（issues 作为警告逐条展示）
    ok: total > 0,
  };
}

// ---------- CSV ----------

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const CN_TIME_HINT = "YYYY-MM-DD HH:mm";

export function parseFlexibleTime(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    const ms = n > 1e12 ? n : n * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const normalized = t.replace(/\//g, "-").replace(" ", "T");
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return null;
  // 不含时区的本地时间补上本地时区偏移，输出 ISO
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(t)) {
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  return d.toISOString();
}

export interface CsvResult {
  kind: "measurement" | "waterchange";
  rows: Measurement[] | WaterChange[];
  issues: ValidationIssue[];
  tankNameToId: Map<string, string>;
}

const MEAS_HEADERS = ["鱼缸", "时间", "pH", "氨氮", "亚硝酸盐", "硝酸盐", "硬度GH", "温度", "备注"];
const WC_HEADERS = ["鱼缸", "时间", "换水比例%", "备注"];

/**
 * 导入 CSV。tankResolver: 按名称找缸；不存在时返回 null（报错指出具体行）
 */
export function parseCsv(
  text: string,
  tankResolver: (name: string) => Tank | undefined,
  idGen: () => string,
): CsvResult | { kind: null; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const rawLines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (rawLines.length === 0) return { kind: null, issues: [issue("(file)", "文件为空")] };
  const header = parseCsvLine(rawLines[0]);
  const kind: "measurement" | "waterchange" | null =
    header.includes("换水比例%") ? "waterchange" : header.includes("氨氮") ? "measurement" : null;
  if (!kind) {
    return {
      kind: null,
      issues: [
        issue("(header)", `无法识别的表头。检测记录表头需为：${MEAS_HEADERS.join(", ")}；换水记录表头需为：${WC_HEADERS.join(", ")}`, header.join(",")),
      ],
    };
  }
  const expected = kind === "measurement" ? MEAS_HEADERS : WC_HEADERS;
  const missing = expected.filter((h) => !header.includes(h));
  if (missing.length) {
    issues.push(issue("(header)", `缺少列：${missing.join("、")}（表头顺序可不同，但名称须一致）`));
    return { kind: null, issues };
  }
  const col = (h: string) => header.indexOf(h);
  const tankNameToId = new Map<string, string>();
  const measRows: Measurement[] = [];
  const wcRows: WaterChange[] = [];

  rawLines.slice(1).forEach((line, idx) => {
    const rowNo = idx + 2; // 含表头的人类行号
    const cells = parseCsvLine(line);
    if (cells.length > header.length) {
      issues.push(issue(`第 ${rowNo} 行`, `列数 ${cells.length} 多于表头 ${header.length}，请检查逗号/引号`, line));
      return;
    }
    const get = (h: string) => (cells[col(h)] ?? "").trim();
    const name = get("鱼缸");
    if (!name) {
      issues.push(issue(`第 ${rowNo} 行 · 鱼缸`, "鱼缸名称为空"));
      return;
    }
    const tank = tankResolver(name);
    if (!tank) {
      issues.push(issue(`第 ${rowNo} 行 · 鱼缸`, `不存在名为「${name}」的鱼缸（请先在本应用中创建，名称需完全一致）`, name));
      return;
    }
    tankNameToId.set(name, tank.id);
    const timeStr = get("时间");
    const time = parseFlexibleTime(timeStr);
    if (!time) {
      issues.push(issue(`第 ${rowNo} 行 · 时间`, `无法解析时间「${timeStr}」，格式示例：${CN_TIME_HINT}`, timeStr));
      return;
    }

    if (kind === "measurement") {
      const values: Measurement["values"] = {};
      const colMap: [MetricKey, string][] = [
        ["ph", "pH"],
        ["ammonia", "氨氮"],
        ["nitrite", "亚硝酸盐"],
        ["nitrate", "硝酸盐"],
        ["hardness", "硬度GH"],
        ["temperature", "温度"],
      ];
      let rowBad = false;
      for (const [k, h] of colMap) {
        const cell = get(h);
        if (cell === "") continue;
        const v = Number(cell);
        if (!Number.isFinite(v)) {
          issues.push(issue(`第 ${rowNo} 行 · ${h}列`, `「${cell}」不是数字`, cell));
          rowBad = true;
          continue;
        }
        const p = METRICS[k].physical;
        if (v < p.min || v > p.max) {
          issues.push(issue(`第 ${rowNo} 行 · ${h}列`, `${METRICS[k].label}=${v} 超出物理可行域 ${p.min}~${p.max}${METRICS[k].unit}`, v));
          rowBad = true;
          continue;
        }
        values[k] = v;
      }
      if (rowBad) return;
      if (Object.keys(values).length === 0) {
        issues.push(issue(`第 ${rowNo} 行`, "至少需要一个指标数值"));
        return;
      }
      measRows.push({ id: idGen(), tankId: tank.id, time, values, note: get("备注") || undefined });
    } else {
      const cell = get("换水比例%");
      const pct = Number(cell);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        issues.push(issue(`第 ${rowNo} 行 · 换水比例%列`, `「${cell}」不是 0~100 之间的数字`, cell));
        return;
      }
      wcRows.push({ id: idGen(), tankId: tank.id, time, percent: pct, note: get("备注") || undefined });
    }
  });

  return kind === "measurement"
    ? { kind, rows: measRows, issues, tankNameToId }
    : { kind, rows: wcRows, issues, tankNameToId };
}

export function measurementCsvTemplate(): string {
  return MEAS_HEADERS.join(",") + "\n草缸A,2026-09-01 09:00,7.0,0.01,0.02,15,6,25.0,例行检测\n";
}

export function waterChangeCsvTemplate(): string {
  return WC_HEADERS.join(",") + "\n草缸A,2026-09-01 18:00,30,常规换水\n";
}
