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
  label: string;
  before: AppData;
  at: number;
}

export interface Notice {
  issues: ValidationIssue[];
  quarantined: { key: string; raw: string; error: string }[];
  seeded: boolean;
}

class Store {
  private data: AppData;
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = []; // after 快照
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

  /** 执行一个可撤销操作 */
  commit(label: string, mutate: (draft: AppData) => void): void {
    const before = structuredClone(this.data);
    const draft = structuredClone(this.data);
    mutate(draft);
    this.undoStack.push({ label, before, at: Date.now() });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.data = draft;
    this.persist();
    this.emit();
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
    this.redoStack.push({ label: e.label, before: structuredClone(this.data), at: Date.now() });
    this.data = e.before;
    this.persist();
    this.emit();
  }

  redo(): void {
    const e = this.redoStack.pop();
    if (!e) return;
    this.undoStack.push({ label: e.label, before: structuredClone(this.data), at: Date.now() });
    this.data = e.before;
    this.persist();
    this.emit();
  }

  clearNotice(): void {
    this.notice = { issues: [], quarantined: [], seeded: false };
    this.emit();
  }

  // ---------- 鱼缸 ----------
  addTank(input: Omit<Tank, "id" | "archived" | "createdAt">): void {
    this.commit("新增鱼缸", (d) => {
      d.tanks.push({ ...input, id: uid("tank"), archived: false, createdAt: new Date().toISOString() });
    });
  }
  updateTank(id: string, patch: Partial<Omit<Tank, "id">>): void {
    this.commit("编辑鱼缸", (d) => {
      const t = d.tanks.find((x) => x.id === id);
      if (t) Object.assign(t, patch);
    });
  }
  setArchived(id: string, archived: boolean): void {
    this.commit(archived ? "归档鱼缸" : "取消归档", (d) => {
      const t = d.tanks.find((x) => x.id === id);
      if (t) t.archived = archived;
    });
  }
  /** 彻底删除鱼缸（连同其记录移入回收站） */
  purgeTank(id: string): void {
    this.commit("删除鱼缸", (d) => {
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
  addType(input: Omit<TankType, "id" | "builtin">): void {
    this.commit("新增缸型", (d) => {
      d.tankTypes.push({ ...input, id: uid("type"), builtin: false });
    });
  }
  updateType(id: string, patch: Partial<Omit<TankType, "id" | "builtin">>): void {
    this.commit("编辑缸型阈值", (d) => {
      const t = d.tankTypes.find((x) => x.id === id);
      if (t) {
        Object.assign(t, patch);
        t.builtin = false; // 修改内置缸型后视为自定义副本
        t.id = id;
      }
    });
  }
  deleteType(id: string): void {
    this.commit("删除缸型", (d) => {
      d.tankTypes = d.tankTypes.filter((t) => t.id !== id);
    });
  }

  // ---------- 检测记录 ----------
  addMeasurement(input: Omit<Measurement, "id">): void {
    this.commit("新增检测记录", (d) => {
      d.measurements.push({ ...input, id: uid("m") });
    });
  }
  updateMeasurement(id: string, patch: Partial<Omit<Measurement, "id">>): void {
    this.commit("编辑检测记录", (d) => {
      const m = d.measurements.find((x) => x.id === id);
      if (m) Object.assign(m, patch);
    });
  }
  deleteMeasurements(ids: string[]): void {
    const set = new Set(ids);
    this.commit(ids.length > 1 ? `删除 ${ids.length} 条检测记录` : "删除检测记录", (d) => {
      const gone = d.measurements.filter((m) => set.has(m.id));
      d.deleted.measurements.push(...gone);
      d.measurements = d.measurements.filter((m) => !set.has(m.id));
    });
  }

  // ---------- 换水 ----------
  addWaterChange(input: Omit<WaterChange, "id">): void {
    this.commit("登记换水", (d) => {
      d.waterChanges.push({ ...input, id: uid("w") });
    });
  }
  updateWaterChange(id: string, patch: Partial<Omit<WaterChange, "id">>): void {
    this.commit("编辑换水记录", (d) => {
      const w = d.waterChanges.find((x) => x.id === id);
      if (w) Object.assign(w, patch);
    });
  }
  deleteWaterChanges(ids: string[]): void {
    const set = new Set(ids);
    this.commit(ids.length > 1 ? `删除 ${ids.length} 条换水记录` : "删除换水记录", (d) => {
      const gone = d.waterChanges.filter((w) => set.has(w.id));
      d.deleted.waterChanges.push(...gone);
      d.waterChanges = d.waterChanges.filter((w) => !set.has(w.id));
    });
  }

  // ---------- 批量导入（单步、可整体撤销） ----------
  importMeasurements(rows: Measurement[]): number {
    this.commit(`批量导入 ${rows.length} 条检测记录`, (d) => {
      d.measurements.push(...rows);
    });
    return rows.length;
  }
  importWaterChanges(rows: WaterChange[]): number {
    this.commit(`批量导入 ${rows.length} 条换水记录`, (d) => {
      d.waterChanges.push(...rows);
    });
    return rows.length;
  }
  replaceAll(next: AppData, label: string): void {
    this.commit(label, (d) => {
      // 保留 nothing — 全量替换；回收站也来自备份（无损导回）
      d.version = next.version;
      d.tankTypes = next.tankTypes;
      d.tanks = next.tanks;
      d.measurements = next.measurements;
      d.waterChanges = next.waterChanges;
      d.deleted = next.deleted;
    });
  }

  resetAll(useSeed: boolean): void {
    const next = useSeed ? seedData() : emptyData();
    this.commit(useSeed ? "恢复示例数据" : "清空全部数据", (d) => {
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
