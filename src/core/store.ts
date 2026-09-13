import { useSyncExternalStore } from "react";
import { loadData } from "./validation";
import { emptyData, seedData } from "./defaults";
import type {
  AppData,
  Measurement,
  Tank,
  TankType,
  ValidationIssue,
  WaterChange,
} from "./types";
import { stableStringify, uid } from "./exporter";

const STORAGE_KEY = "aq-workbench-data-v1";
const UNDO_LIMIT = 50;

interface UndoEntry {
  id: string;
  label: string;
  before: AppData;
  after: AppData;
  at: number;
  /**
   * 条件化补丁标记：
   *  - dir "forward" 且 snapshot 为该操作的 before 世界：在当前世界把仍等于 before 的实体前推到 after。
   */
  patch?: {
    dir: "forward";
    snapshot: AppData;
    survivors?: Map<string, Entity>;
  };
}

export interface UndoResult {
  applied: number;
  skipped: number;
  notFound: boolean;
}

export interface Notice {
  issues: ValidationIssue[];
  quarantined: { key: string; raw: string; error: string }[];
  seeded: boolean;
}

type Entity = { id: string };
type CollectionPath = ["tanks"] | ["tankTypes"] | ["measurements"] | ["waterChanges"] | ["deleted", "measurements"] | ["deleted", "waterChanges"] | ["deleted", "tanks"];
const COLLECTION_PATHS: CollectionPath[] = [
  ["tanks"],
  ["tankTypes"],
  ["measurements"],
  ["waterChanges"],
  ["deleted", "measurements"],
  ["deleted", "waterChanges"],
  ["deleted", "tanks"],
];

function getCollection(d: AppData, p: CollectionPath): Entity[] {
  return p.length === 1 ? (d[p[0]] as Entity[]) : ((d.deleted as unknown as Record<string, Entity[]>)[p[1]]);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== "object") return a === b;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/**
 * 把「before→after」这次操作的逆补丁应用到 target 上（条件化：只回退未被后续操作改动的实体）。
 * 新增且未被改动的 → 删除；被删且未复活的 → 从 before 恢复；被改且当前仍等于 after 版本的 → 还原 before。
 * 已被后续操作改动/复活的实体跳过并计数。
 * survivors：定向撤销时在当前数据中被跳过的实体（之后又被改过）；变换历史快照时以其当前版本占位，
 * 避免撤销链上的新增实体在更早快照里被抹掉、再 Ctrl+Z 时意外消失。
 */
function applyInverse(
  target: AppData,
  before: AppData,
  after: AppData,
  survivors?: Map<string, Entity>,
): UndoResult {
  const res: UndoResult = { applied: 0, skipped: 0, notFound: false };
  for (const p of COLLECTION_PATHS) {
    const collName = p.join(".");
    const cur = getCollection(target, p);
    const b = new Map(getCollection(before, p).map((e) => [e.id, e]));
    const a = new Map(getCollection(after, p).map((e) => [e.id, e]));
    const curMap = new Map(cur.map((e) => [e.id, e]));

    for (const [id, afterEntity] of a) {
      const beforeEntity = b.get(id);
      const curEntity = curMap.get(id);
      if (!beforeEntity) {
        // 本次操作新增
        if (!curEntity) continue; // 已被后续操作删除，无需处理
        if (deepEqual(curEntity, afterEntity)) {
          const survivor = survivors?.get(`${collName}:${id}`);
          const idx = cur.indexOf(curEntity);
          if (survivor && !deepEqual(survivor, afterEntity)) {
            cur[idx] = structuredClone(survivor); // 占位：保留它在当前数据中的版本
          } else {
            cur.splice(idx, 1);
          }
          res.applied++;
        } else {
          res.skipped++; // 新增后又被后续操作修改，保留
        }
      } else if (!deepEqual(beforeEntity, afterEntity)) {
        // 本次操作修改
        if (!curEntity) continue; // 已被后续操作删除，不复活
        if (deepEqual(curEntity, afterEntity)) {
          cur[cur.indexOf(curEntity)] = structuredClone(beforeEntity);
          res.applied++;
        } else {
          res.skipped++; // 之后又被改动，不覆盖
        }
      }
    }
    for (const [id, beforeEntity] of b) {
      if (!a.has(id)) {
        // 本次操作删除（含在集合间移动）
        if (curMap.has(id)) {
          res.skipped++; // 同名实体已重新出现，保留现状
        } else {
          cur.push(structuredClone(beforeEntity));
          res.applied++;
        }
      }
    }
  }
  return res;
}

function cloneData(d: AppData): AppData {
  return structuredClone(d);
}

/**
 * 把「before→after」这次操作的前向补丁条件化应用到 target。
 * 仅当实体当前仍等于 before 版本时才前推到 after；已被改动/被删/已存在则跳过。
 */
function applyForward(target: AppData, before: AppData, after: AppData): UndoResult {
  const res: UndoResult = { applied: 0, skipped: 0, notFound: false };
  for (const p of COLLECTION_PATHS) {
    const cur = getCollection(target, p);
    const b = new Map(getCollection(before, p).map((e) => [e.id, e]));
    const a = new Map(getCollection(after, p).map((e) => [e.id, e]));
    const curMap = new Map(cur.map((e) => [e.id, e]));

    for (const [id, afterEntity] of a) {
      const beforeEntity = b.get(id);
      const curEntity = curMap.get(id);
      if (!beforeEntity) {
        // 本次操作新增
        if (curEntity) {
          res.skipped++; // 已存在（可能被重新创建），不覆盖
        } else {
          cur.push(structuredClone(afterEntity));
          res.applied++;
        }
      } else if (!deepEqual(beforeEntity, afterEntity)) {
        // 本次操作修改
        if (!curEntity) {
          res.skipped++; // 已被后续删除，不复活
        } else if (deepEqual(curEntity, beforeEntity)) {
          cur[cur.indexOf(curEntity)] = structuredClone(afterEntity);
          res.applied++;
        } else {
          res.skipped++;
        }
      }
    }
    for (const [id] of b) {
      if (!a.has(id)) {
        // 本次操作删除
        const curEntity = curMap.get(id);
        if (!curEntity) continue; // 本就不在
        if (deepEqual(curEntity, b.get(id)!)) {
          cur.splice(cur.indexOf(curEntity), 1);
          res.applied++;
        } else {
          res.skipped++;
        }
      }
    }
  }
  return res;
}

/** 计算条件化前推时的"之后又被改动"幸存者（当前世界里相对 after 已不同的实体） */
function collectSurvivors(current: AppData, before: AppData, after: AppData): Map<string, Entity> {
  const survivors = new Map<string, Entity>();
  for (const p of COLLECTION_PATHS) {
    const collName = p.join(".");
    const curMap = new Map(getCollection(current, p).map((e) => [e.id, e]));
    const b = new Map(getCollection(before, p).map((e) => [e.id, e]));
    for (const e of getCollection(after, p)) {
      if (!b.has(e.id)) {
        const curEntity = curMap.get(e.id);
        if (curEntity && !deepEqual(curEntity, e)) survivors.set(`${collName}:${e.id}`, curEntity);
      }
    }
  }
  return survivors;
}

export class Store {
  private data: AppData;
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private listeners = new Set<() => void>();
  notice: Notice = { issues: [], quarantined: [], seeded: false };

  constructor() {
    let loaded: ReturnType<typeof loadData>;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      raw = null;
    }
    loaded = loadData(raw);
    if (loaded.data) {
      this.data = loaded.data;
      // 恢复后立即写回一次清洗结果（修复可修复的结构问题）
      this.persist();
    } else if (loaded.rawCorrupted) {
      this.data = emptyData();
      this.persist();
    } else {
      this.data = seedData();
      this.notice.seeded = true;
      this.persist();
    }
    this.notice.issues = loaded.issues;
    this.notice.quarantined = loaded.quarantined;
  }

  getData = (): AppData => this.data;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit() {
    this.listeners.forEach((l) => l());
  }

  private persist() {
    try {
      localStorage.setItem(STORAGE_KEY, stableStringify(this.data, 0));
    } catch (e) {
      // 存储满/隐私模式：应用仍可在内存中使用
      console.warn("persist failed", e);
    }
  }

  /** 执行一个可撤销操作，返回操作 id（供定向撤销使用） */
  commit(label: string, mutate: (draft: AppData) => void): string {
    const before = cloneData(this.data);
    const draft = cloneData(this.data);
    mutate(draft);
    const id = uid("op");
    this.undoStack.push({ id, label, before, after: draft, at: Date.now() });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.data = draft;
    this.persist();
    this.emit();
    return id;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }
  redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null;
  }

  undo(): void {
    const e = this.undoStack.pop();
    if (!e) return;
    this.redoStack.push({ id: e.id, label: e.label, before: cloneData(this.data), after: e.before, at: Date.now() });
    this.data = e.before;
    this.persist();
    this.emit();
  }

  redo(): void {
    const e = this.redoStack.pop();
    if (!e) return;
    if (e.patch?.dir === "forward") {
      // 条件化重做（来自一次旧 toast 的定向撤销）：在当前世界把该操作的效果前推
      const next = cloneData(this.data);
      applyForward(next, e.patch.snapshot, e.after);
      this.undoStack.push({
        id: e.id,
        label: e.label,
        before: cloneData(this.data),
        after: next,
        at: Date.now(),
      });
      this.data = next;
    } else {
      this.undoStack.push({ id: e.id, label: e.label, before: cloneData(this.data), after: e.before, at: Date.now() });
      this.data = e.before;
    }
    this.persist();
    this.emit();
  }

  /**
   * 定向撤销：只回退 id 指定的那一次操作，保留之后其它操作的结果。
   * - 若该操作就在撤销栈顶：等同线性撤销，Ctrl+Y 可原样重做；
   * - 若它之上还有其它操作：在当前世界里条件化回退该操作（之后又被改动的实体跳过），
   *   并把"条件化重做这一次操作"压入重做栈；同一逆补丁同时沿历史变换更新更老的快照，
   *   使随后 Ctrl+Z 仍然线性一致。
   */
  undoAction(id: string): UndoResult {
    const idx = this.undoStack.findIndex((e) => e.id === id);
    if (idx < 0) return { applied: 0, skipped: 0, notFound: true };
    const entry = this.undoStack[idx];

    // 栈顶：走线性路径，保留标准 redo
    if (idx === this.undoStack.length - 1) {
      this.undo();
      return { applied: 1, skipped: 0, notFound: false };
    }

    const next = cloneData(this.data);
    const survivors = collectSurvivors(next, entry.before, entry.after);
    const result = applyInverse(next, entry.before, entry.after, survivors);
    if (result.applied === 0 && result.skipped === 0) {
      // 操作效果已不存在（被后续操作完全覆盖），仅从历史中摘掉
      this.undoStack.splice(idx, 1);
    } else {
      // 条件化重做入口：在重做后的世界里把仍处于 before 版本的实体前推回 after
      this.redoStack.push({
        id: uid("redo"),
        label: `重做：${entry.label}`,
        before: cloneData(next),
        after: entry.after,
        at: Date.now(),
        patch: { dir: "forward", snapshot: entry.before },
      });
      // 变换更新的历史快照（idx 之上的条目），保持 Ctrl+Z 线性一致
      for (let i = idx + 1; i < this.undoStack.length; i++) {
        applyInverse(this.undoStack[i].before, entry.before, entry.after, survivors);
        applyInverse(this.undoStack[i].after, entry.before, entry.after, survivors);
      }
      this.undoStack.splice(idx, 1);
      this.data = next;
    }
    this.persist();
    this.emit();
    return result;
  }

  clearNotice(): void {
    this.notice = { issues: [], quarantined: [], seeded: false };
    this.emit();
  }

  /** 测试用：直接替换内存数据并清空撤销/重做栈 */
  __resetForTests(next: AppData): void {
    this.data = structuredClone(next);
    this.undoStack = [];
    this.redoStack = [];
  }

  // ---------- 鱼缸 ----------
  addTank(input: Omit<Tank, "id" | "archived" | "createdAt">): string {
    return this.commit("新增鱼缸", (d) => {
      d.tanks.push({ ...input, id: uid("tank"), archived: false, createdAt: new Date().toISOString() });
    });
  }
  updateTank(id: string, patch: Partial<Omit<Tank, "id">>): string {
    return this.commit("编辑鱼缸", (d) => {
      const t = d.tanks.find((x) => x.id === id);
      if (t) Object.assign(t, patch);
    });
  }
  setArchived(id: string, archived: boolean): string {
    return this.commit(archived ? "归档鱼缸" : "取消归档", (d) => {
      const t = d.tanks.find((x) => x.id === id);
      if (t) t.archived = archived;
    });
  }
  /** 彻底删除鱼缸（连同其记录移入回收站） */
  purgeTank(id: string): string {
    return this.commit("删除鱼缸", (d) => {
      const t = d.tanks.find((x) => x.id === id);
      if (!t) return;
      d.deleted.tanks.push(t);
      d.tanks = d.tanks.filter((x) => x.id !== id);
      d.deleted.measurements.push(...d.measurements.filter((m) => m.tankId === id));
      d.deleted.waterChanges.push(...d.waterChanges.filter((w) => w.tankId === id));
      d.measurements = d.measurements.filter((m) => m.tankId !== id);
      d.waterChanges = d.waterChanges.filter((w) => w.tankId !== id);
    });
  }

  // ---------- 缸型 ----------
  addType(input: Omit<TankType, "id" | "builtin">): string {
    return this.commit("新增缸型", (d) => {
      d.tankTypes.push({ ...input, id: uid("type"), builtin: false });
    });
  }
  updateType(id: string, patch: Partial<Omit<TankType, "id" | "builtin">>): string {
    return this.commit("编辑缸型阈值", (d) => {
      const t = d.tankTypes.find((x) => x.id === id);
      if (t) {
        Object.assign(t, patch);
        t.builtin = false; // 修改内置缸型后视为自定义副本
      }
    });
  }
  deleteType(id: string): string {
    return this.commit("删除缸型", (d) => {
      d.tankTypes = d.tankTypes.filter((t) => t.id !== id);
    });
  }

  // ---------- 检测记录 ----------
  addMeasurement(input: Omit<Measurement, "id">): string {
    return this.commit("新增检测记录", (d) => {
      d.measurements.push({ ...input, id: uid("m") });
    });
  }
  updateMeasurement(id: string, patch: Partial<Omit<Measurement, "id">>): string {
    return this.commit("编辑检测记录", (d) => {
      const m = d.measurements.find((x) => x.id === id);
      if (m) Object.assign(m, patch);
    });
  }
  deleteMeasurements(ids: string[]): string {
    const set = new Set(ids);
    return this.commit(ids.length > 1 ? `删除 ${ids.length} 条检测记录` : "删除检测记录", (d) => {
      const gone = d.measurements.filter((m) => set.has(m.id));
      d.deleted.measurements.push(...gone);
      d.measurements = d.measurements.filter((m) => !set.has(m.id));
    });
  }

  // ---------- 换水 ----------
  addWaterChange(input: Omit<WaterChange, "id">): string {
    return this.commit("登记换水", (d) => {
      d.waterChanges.push({ ...input, id: uid("w") });
    });
  }
  updateWaterChange(id: string, patch: Partial<Omit<WaterChange, "id">>): string {
    return this.commit("编辑换水记录", (d) => {
      const w = d.waterChanges.find((x) => x.id === id);
      if (w) Object.assign(w, patch);
    });
  }
  deleteWaterChanges(ids: string[]): string {
    const set = new Set(ids);
    return this.commit(ids.length > 1 ? `删除 ${ids.length} 条换水记录` : "删除换水记录", (d) => {
      const gone = d.waterChanges.filter((w) => set.has(w.id));
      d.deleted.waterChanges.push(...gone);
      d.waterChanges = d.waterChanges.filter((w) => !set.has(w.id));
    });
  }

  // ---------- 批量导入（单步、可整体撤销） ----------
  importMeasurements(rows: Measurement[]): string {
    return this.commit(`批量导入 ${rows.length} 条检测记录`, (d) => {
      d.measurements.push(...rows);
    });
  }
  importWaterChanges(rows: WaterChange[]): string {
    return this.commit(`批量导入 ${rows.length} 条换水记录`, (d) => {
      d.waterChanges.push(...rows);
    });
  }
  replaceAll(next: AppData, label: string): string {
    return this.commit(label, (d) => {
      // 全量替换；回收站也来自备份（无损导回）
      d.version = next.version;
      d.tankTypes = next.tankTypes;
      d.tanks = next.tanks;
      d.measurements = next.measurements;
      d.waterChanges = next.waterChanges;
      d.deleted = next.deleted;
    });
  }

  resetAll(useSeed: boolean): string {
    const next = useSeed ? seedData() : emptyData();
    return this.commit(useSeed ? "恢复示例数据" : "清空全部数据", (d) => {
      d.version = next.version;
      d.tankTypes = next.tankTypes;
      d.tanks = next.tanks;
      d.measurements = next.measurements;
      d.waterChanges = next.waterChanges;
      d.deleted = next.deleted;
    });
  }
}

export const store = new Store();

export function useStore(): AppData {
  return useSyncExternalStore(store.subscribe, store.getData, store.getData);
}
