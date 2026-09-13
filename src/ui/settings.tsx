import { useRef, useState } from "react";
import type { AppData, ValidationIssue } from "../core/types";
import { store } from "../core/store";
import { parseBackup, parseCsv, measurementCsvTemplate, waterChangeCsvTemplate } from "../core/validation";
import { downloadText, measurementsToCsv, toBackupJson, waterChangesToCsv } from "../core/exporter";
import { useConfirm } from "./widgets";

type ToastFn = (text: string, action?: { label: string; run: () => void }) => void;

function IssueList({ issues }: { issues: ValidationIssue[] }): JSX.Element {
  if (issues.length === 0) return <p className="ok-text">未发现问题。</p>;
  return (
    <ul className="issue-list">
      {issues.map((i, idx) => (
        <li key={idx}>
          <code className="issue-path">{i.path}</code>
          <span>{i.message}</span>
          {i.value !== undefined && <code className="issue-value">{String(i.value)}</code>}
        </li>
      ))}
    </ul>
  );
}

function FilePick({ accept, onPick, label, kind }: { accept: string; onPick: (text: string, name: string) => void; label: string; kind: "csv" | "json" }): JSX.Element {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        data-file={kind}
        accept={accept}
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          const input = e.target;
          f.text().then((t) => {
            onPick(t, f.name);
            input.value = "";
          });
        }}
      />
      <button className="btn" onClick={() => ref.current?.click()}>
        {label}
      </button>
    </>
  );
}

export function SettingsView({ data, toast }: { data: AppData; toast: ToastFn }): JSX.Element {
  const confirm = useConfirm();
  const [preview, setPreview] = useState<
    | { kind: "meas" | "wc"; rows: unknown[]; issues: ValidationIssue[]; fileName: string }
    | { kind: "backup"; result: ReturnType<typeof parseBackup>; fileName: string }
    | null
  >(null);

  const tankName = (id: string) => data.tanks.find((t) => t.id === id)?.name ?? "(已删除的缸)";

  const onCsv = (text: string, fileName: string) => {
    const r = parseCsv(
      text,
      (name) => data.tanks.find((t) => t.name === name && !t.archived) ?? data.tanks.find((t) => t.name === name),
      () => `imp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    );
    if (r.kind === null) {
      setPreview({ kind: "meas", rows: [], issues: r.issues, fileName });
      return;
    }
    setPreview({ kind: r.kind === "measurement" ? "meas" : "wc", rows: r.rows, issues: r.issues, fileName });
  };

  const onBackup = (text: string, fileName: string) => {
    setPreview({ kind: "backup", result: parseBackup(text), fileName });
  };

  const doImportCsv = () => {
    if (!preview || preview.kind === "backup") return;
    const n = preview.rows.length;
    if (n === 0) return;
    if (preview.kind === "meas") store.importMeasurements(preview.rows as never);
    else store.importWaterChanges(preview.rows as never);
    const label = `批量导入 ${n} 条${preview.kind === "meas" ? "检测" : "换水"}记录`;
    setPreview(null);
    toast(`已${label}（文件：${preview.fileName}）${preview.issues.length ? `，另有 ${preview.issues.length} 条问题行未导入` : ""}`, {
      label: "撤销导入",
      run: () => store.undo(),
    });
    void label;
  };

  const doImportBackup = () => {
    if (!preview || preview.kind !== "backup" || !preview.result.data) return;
    const next = preview.result.data;
    const label = `导入备份「${preview.fileName}」`;
    store.replaceAll(next, label);
    setPreview(null);
    toast("备份已无损导回（全量替换，含缸型阈值与回收站）", { label: "撤销", run: () => store.undo() });
  };

  return (
    <div className="settings-grid">
      <section className="panel">
        <div className="section-heading">
          <div>
            <p>数据导出</p>
            <h2>备份与表格</h2>
          </div>
        </div>
        <p className="muted">
          JSON 全量备份包含鱼缸、缸型阈值、检测/换水记录及回收站，重新导回无损；CSV 适合在 Excel 中整理后批量导回（按鱼缸名称匹配）。
        </p>
        <div className="btn-row">
          <button
            className="btn primary"
            onClick={() => downloadText(`aquarium-backup-${new Date().toISOString().slice(0, 10)}.json`, toBackupJson(data), "application/json")}
          >
            导出全量备份（JSON）
          </button>
          <button className="btn" onClick={() => downloadText("measurements.csv", measurementsToCsv(data, tankName), "text/csv;charset=utf-8")}>
            导出检测记录（CSV）
          </button>
          <button className="btn" onClick={() => downloadText("water-changes.csv", waterChangesToCsv(data, tankName), "text/csv;charset=utf-8")}>
            导出换水记录（CSV）
          </button>
        </div>
        <div className="btn-row">
          <button className="btn ghost" onClick={() => downloadText("measurement-template.csv", measurementCsvTemplate(), "text/csv;charset=utf-8")}>
            下载检测 CSV 模板
          </button>
          <button className="btn ghost" onClick={() => downloadText("waterchange-template.csv", waterChangeCsvTemplate(), "text/csv;charset=utf-8")}>
            下载换水 CSV 模板
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p>批量导入</p>
            <h2>导入前校验，错误定位到行列</h2>
          </div>
        </div>
        <div className="btn-row">
          <FilePick kind="csv" accept=".csv,text/csv" label="选择 CSV 文件…" onPick={onCsv} />
          <FilePick kind="json" accept=".json,application/json" label="选择 JSON 备份…" onPick={onBackup} />
        </div>

        {preview?.kind !== "backup" && preview && (
          <div className="import-preview">
            <h4>
              {preview.fileName} · 可导入 <b className="ok-text">{preview.rows.length}</b> 行 · 问题 <b className={preview.issues.length ? "danger-text" : "ok-text"}>
                {preview.issues.length}
              </b>
            </h4>
            <IssueList issues={preview.issues} />
            <div className="btn-row">
              <button className="btn primary" disabled={preview.rows.length === 0} onClick={doImportCsv}>
                导入 {preview.rows.length} 行（整批可撤销）
              </button>
              <button className="btn" onClick={() => setPreview(null)}>
                取消
              </button>
            </div>
          </div>
        )}
        {preview?.kind === "backup" && (
          <div className="import-preview">
            <h4>
              {preview.fileName} · 缸 {preview.result.imported.tanks} · 缸型 {preview.result.imported.types} · 检测 {preview.result.imported.measurements} · 换水{" "}
              {preview.result.imported.waterChanges} · 问题 {preview.result.issues.length}
            </h4>
            <IssueList issues={preview.result.issues} />
            <div className="btn-row">
              <button className="btn primary" disabled={!preview.result.data} onClick={doImportBackup}>
                全量无损导回（替换当前数据，可撤销）
              </button>
              <button className="btn" onClick={() => setPreview(null)}>
                取消
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p>本地存储</p>
            <h2>离线与重置</h2>
          </div>
        </div>
        <ul className="storage-stats">
          <li>数据保存在本浏览器 localStorage，断网可用，刷新全量恢复。</li>
          <li>
            当前：{data.tanks.length} 个鱼缸（{data.tanks.filter((t) => !t.archived).length} 在养 / {data.tanks.filter((t) => t.archived).length} 归档）·{" "}
            {data.measurements.length} 条检测 · {data.waterChanges.length} 条换水 · 回收站{" "}
            {data.deleted.measurements.length + data.deleted.waterChanges.length + data.deleted.tanks.length} 项
          </li>
          <li>
            占用约 <b>{(new Blob([JSON.stringify(data)]).size / 1024).toFixed(1)} KB</b>
          </li>
        </ul>
        <div className="btn-row">
          <button
            className="btn ghost"
            onClick={() =>
              confirm.ask("恢复为内置示例数据？当前数据会被替换（可撤销）。", () => {
                store.resetAll(true);
                toast("已恢复示例数据", { label: "撤销", run: () => store.undo() });
              })
            }
          >
            恢复示例数据
          </button>
          <button
            className="btn danger"
            onClick={() =>
              confirm.ask("确定清空全部鱼缸与记录？此操作本身可撤销，但建议先导出 JSON 备份。", () => {
                store.resetAll(false);
                toast("已清空全部数据", { label: "撤销", run: () => store.undo() });
              })
            }
          >
            清空全部数据
          </button>
        </div>
        {confirm.node}
      </section>
    </div>
  );
}
