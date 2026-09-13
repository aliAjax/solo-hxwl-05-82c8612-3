import type { AppData, Measurement, WaterChange } from "./types";
import { METRIC_KEYS } from "./metrics";
import { parseCsvLine } from "./validation";

const PAD = (n: number) => String(n).padStart(2, "0");

export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}T${PAD(d.getHours())}:${PAD(d.getMinutes())}`;
}

export function nowLocalInput(): string {
  return toLocalInput(new Date().toISOString());
}

function csvCell(v: string | number | undefined | null): string {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function measurementsToCsv(data: AppData, tankName: (id: string) => string, rows?: Measurement[]): string {
  const list = (rows ?? data.measurements).slice().sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const header = ["鱼缸", "时间", "pH", "氨氮", "亚硝酸盐", "硝酸盐", "硬度GH", "温度", "备注"];
  const lines = [header.join(",")];
  for (const m of list) {
    lines.push(
      [
        csvCell(tankName(m.tankId)),
        csvCell(new Date(m.time).toLocaleString("zh-CN", { hour12: false }).replace(/\//g, "-")),
        ...METRIC_KEYS.map((k) => (m.values[k] === undefined ? "" : csvCell(m.values[k]))),
        csvCell(m.note),
      ].join(","),
    );
  }
  return "﻿" + lines.join("\n");
}

export function waterChangesToCsv(data: AppData, tankName: (id: string) => string, rows?: WaterChange[]): string {
  const list = (rows ?? data.waterChanges).slice().sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const lines = [["鱼缸", "时间", "换水比例%", "备注"].join(",")];
  for (const w of list) {
    lines.push(
      [
        csvCell(tankName(w.tankId)),
        csvCell(new Date(w.time).toLocaleString("zh-CN", { hour12: false }).replace(/\//g, "-")),
        csvCell(w.percent),
        csvCell(w.note),
      ].join(","),
    );
  }
  return "﻿" + lines.join("\n");
}

/** 全量无损备份（含缸型阈值、回收站），与导入格式一致。
 *  稳定序列化：递归按键名排序，保证「导出→导回→再导出」字节一致（无损往返）。 */
export function stableStringify(value: unknown, indent: number = 2): string {
  const seen = new WeakSet<object>();
  const render = (v: unknown, depth: number): string => {
    const pad = " ".repeat(depth * indent);
    const padInner = " ".repeat((depth + 1) * indent);
    if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
    const obj = v as Record<string, unknown>;
    if (seen.has(obj)) return "null";
    seen.add(obj);
    if (Array.isArray(obj)) {
      if (obj.length === 0) return "[]";
      return `[\n${obj.map((x) => padInner + render(x, depth + 1)).join(",\n")}\n${pad}]`;
    }
    const keys = Object.keys(obj).sort().filter((k) => obj[k] !== undefined);
    if (keys.length === 0) return "{}";
    return `{\n${keys.map((k) => `${padInner}${JSON.stringify(k)}: ${render(obj[k], depth + 1)}`).join(",\n")}\n${pad}}`;
  };
  return render(value, 0);
}

export function toBackupJson(data: AppData): string {
  return stableStringify(data, 2);
}

export function downloadText(filename: string, text: string, mime: string = "text/plain;charset=utf-8"): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function uid(prefix: string = "id"): string {
  const rnd =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rnd}`;
}

/** CSV 预览解析（供界面前端检查列数，不做语义校验） */
export function previewCsvHeader(text: string): string[] {
  const first = text.replace(/^﻿/, "").split(/\r?\n/)[0] ?? "";
  return parseCsvLine(first);
}
