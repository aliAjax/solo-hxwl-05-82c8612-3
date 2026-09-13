import { useMemo, useState } from "react";
import type { AppData, Measurement, MetricKey, Tank, WaterChange } from "../core/types";
import { METRICS, METRIC_KEYS, formatMetric, outsideRange } from "../core/metrics";
import { resolveType } from "../core/analysis";
import { store } from "../core/store";
import { nowLocalInput, toLocalInput } from "../core/exporter";
import { Field, Modal, TextInput, useConfirm } from "./widgets";

// ---------- 检测记录编辑 ----------

interface MeasDraft {
  tankId: string;
  time: string;
  values: Record<string, string>;
  note: string;
}

function draftFrom(m: Measurement | null, tanks: Tank[]): MeasDraft {
  const v: Record<string, string> = {};
  if (m) METRIC_KEYS.forEach((k) => (v[k] = m.values[k] !== undefined ? String(m.values[k]) : ""));
  return {
    tankId: m?.tankId ?? tanks.find((t) => !t.archived)?.id ?? "",
    time: m ? toLocalInput(m.time) : nowLocalInput(),
    values: v,
    note: m?.note ?? "",
  };
}

export function MeasurementModal({
  open,
  onClose,
  data,
  editing,
  defaultTankId,
}: {
  open: boolean;
  onClose: () => void;
  data: AppData;
  editing: Measurement | null;
  defaultTankId?: string;
}): JSX.Element {
  const tanks = data.tanks.filter((t) => !t.archived);
  const [d, setD] = useState<MeasDraft>(() => {
    const draft = draftFrom(editing, tanks);
    if (!draft.tankId && defaultTankId) draft.tankId = defaultTankId;
    return draft;
  });
  const tank = data.tanks.find((t) => t.id === d.tankId);
  const type = data.tankTypes.find((t) => t.id === tank?.typeId);

  const errors: Partial<Record<MetricKey | "time" | "tank", string>> = {};
  if (!d.tankId) errors.tank = "请选择鱼缸";
  if (!d.time || Number.isNaN(Date.parse(d.time))) errors.time = "请选择有效时间";
  for (const k of METRIC_KEYS) {
    const s = d.values[k];
    if (s === undefined || s === "") continue;
    const n = Number(s);
    const p = METRICS[k].physical;
    if (Number.isNaN(n) || n < p.min || n > p.max) errors[k] = `需为 ${p.min}~${p.max} 之间的数字`;
  }
  const filled = METRIC_KEYS.filter((k) => d.values[k] !== "" && d.values[k] !== undefined).length;
  const valid = !errors.tank && !errors.time && filled > 0 && METRIC_KEYS.every((k) => !errors[k]);

  const save = () => {
    if (!valid) return;
    const values: Measurement["values"] = {};
    for (const k of METRIC_KEYS) {
      const s = d.values[k];
      if (s !== undefined && s !== "") values[k] = Number(s);
    }
    const payload = { tankId: d.tankId, time: new Date(d.time).toISOString(), values, note: d.note.trim() || undefined };
    if (editing) store.updateMeasurement(editing.id, payload);
    else store.addMeasurement(payload);
    onClose();
  };

  return (
    <Modal
      open={open}
      wide
      title={editing ? "编辑检测记录" : "新增检测记录"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={!valid} onClick={save}>
            保存
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="鱼缸" error={errors.tank}>
          <select className="input" value={d.tankId} onChange={(e) => setD({ ...d, tankId: e.target.value })}>
            <option value="">请选择…</option>
            {tanks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="检测时间" error={errors.time}>
          <TextInput type="datetime-local" value={d.time} onChange={(e) => setD({ ...d, time: e.target.value })} />
        </Field>
      </div>
      <div className="metric-input-grid">
        {METRIC_KEYS.map((k) => {
          const def = METRICS[k];
          const range = type?.ranges[k];
          const s = d.values[k];
          const n = s === "" || s === undefined ? NaN : Number(s);
          const out = range && !Number.isNaN(n) && outsideRange(n, range);
          return (
            <div key={k} className={`metric-input ${out ? "out" : ""} ${errors[k] ? "bad" : ""}`}>
              <label>
                <span className="metric-name">
                  {def.label} <em>{range ? `安全 ${range.min}~${range.max}${def.unit}` : `可行 ${def.physical.min}~${def.physical.max}${def.unit}`}</em>
                </span>
                <div className="metric-value-row">
                  <input
                    className="input"
                    type="number"
                    step={def.step}
                    value={s ?? ""}
                    placeholder="—"
                    onChange={(e) => setD({ ...d, values: { ...d.values, [k]: e.target.value } })}
                  />
                  <i className="unit">{def.unit || "—"}</i>
                </div>
                {(errors[k] || out) && (
                  <span className="field-error">{errors[k] ?? (out ? `超出${type!.name}安全区间（仍可保存，将生成待办）` : "")}</span>
                )}
              </label>
            </div>
          );
        })}
      </div>
      <Field label="备注">
        <TextInput value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} placeholder="如：换水前检测" />
      </Field>
    </Modal>
  );
}

// ---------- 换水记录编辑 ----------

interface WcDraft {
  tankId: string;
  time: string;
  percent: string;
  note: string;
}

export function WaterChangeModal({
  open,
  onClose,
  data,
  editing,
  defaultTankId,
}: {
  open: boolean;
  onClose: () => void;
  data: AppData;
  editing: WaterChange | null;
  defaultTankId?: string;
}): JSX.Element {
  const tanks = data.tanks.filter((t) => !t.archived);
  const [d, setD] = useState<WcDraft>(() => ({
    tankId: editing?.tankId ?? defaultTankId ?? tanks[0]?.id ?? "",
    time: editing ? toLocalInput(editing.time) : nowLocalInput(),
    percent: editing ? String(editing.percent) : "30",
    note: editing?.note ?? "",
  }));
  const pct = Number(d.percent);
  const pctErr = d.percent === "" || Number.isNaN(pct) || pct <= 0 || pct > 100 ? "需为 0~100 之间的数字" : undefined;
  const valid = d.tankId && d.time && !pctErr;

  const save = () => {
    if (!valid) return;
    const payload = { tankId: d.tankId, time: new Date(d.time).toISOString(), percent: pct, note: d.note.trim() || undefined };
    if (editing) store.updateWaterChange(editing.id, payload);
    else store.addWaterChange(payload);
    onClose();
  };

  return (
    <Modal
      open={open}
      title={editing ? "编辑换水记录" : "登记换水"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={!valid} onClick={save}>
            保存
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="鱼缸">
          <select className="input" value={d.tankId} onChange={(e) => setD({ ...d, tankId: e.target.value })}>
            {tanks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="换水时间">
          <TextInput type="datetime-local" value={d.time} onChange={(e) => setD({ ...d, time: e.target.value })} />
        </Field>
        <Field label="换水比例（%）" error={pctErr}>
          <TextInput type="number" min={1} max={100} step={1} value={d.percent} onChange={(e) => setD({ ...d, percent: e.target.value })} />
        </Field>
        <Field label="备注">
          <TextInput value={d.note} onChange={(e) => setD({ ...d, note: e.target.value })} placeholder="如：常规换水、清洗滤棉" />
        </Field>
      </div>
      <div className="pct-quick">
        {[15, 25, 30, 50, 80].map((p) => (
          <button key={p} type="button" className={`chip-btn ${pct === p ? "active" : ""}`} onClick={() => setD({ ...d, percent: String(p) })}>
            {p}%
          </button>
        ))}
      </div>
    </Modal>
  );
}

// ---------- 记录列表 ----------

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(
    d.getHours(),
  ).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function MeasurementList({
  data,
  tankFilter,
  onEdit,
  onDeleted,
}: {
  data: AppData;
  tankFilter?: string;
  onEdit: (m: Measurement) => void;
  onDeleted: (n: number, opId: string) => void;
}): JSX.Element {
  const confirm = useConfirm();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const rows = useMemo(() => {
    return data.measurements
      .filter((m) => (tankFilter ? m.tankId === tankFilter : true))
      .map((m) => {
        const tank = data.tanks.find((t) => t.id === m.tankId);
        return { m, tank, type: tank ? resolveType(data, tank) : undefined };
      })
      .sort((a, b) => Date.parse(b.m.time) - Date.parse(a.m.time));
  }, [data, tankFilter]);

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const visibleIds = rows.map((r) => r.m.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));

  const remove = (ids: string[]) => {
    const n = ids.length;
    const opId = store.deleteMeasurements(ids);
    setSelected(new Set());
    onDeleted(n, opId);
  };

  if (rows.length === 0) return <p className="empty-hint">还没有检测记录，点击「新增检测」开始。</p>;

  return (
    <div className="table-wrap">
      <div className="batch-bar">
        <label className="check-all">
          <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(visibleIds))} /> 全选
        </label>
        <button className="btn small danger" disabled={selected.size === 0} onClick={() => remove([...selected])}>
          删除选中（{selected.size}）
        </button>
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th className="col-check" />
            <th>时间</th>
            <th>鱼缸</th>
            {METRIC_KEYS.map((k) => (
              <th key={k}>{METRICS[k].label}</th>
            ))}
            <th>备注</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ m, tank, type }) => (
            <tr key={m.id} className={selected.has(m.id) ? "selected" : ""}>
              <td className="col-check">
                <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggle(m.id)} />
              </td>
              <td className="nowrap">{fmtTime(m.time)}</td>
              <td>{tank?.name ?? <span className="missing-ref">未知缸({m.tankId.slice(0, 6)})</span>}</td>
              {METRIC_KEYS.map((k) => {
                const v = m.values[k];
                const range = type?.ranges[k];
                const out = typeof v === "number" && range && outsideRange(v, range);
                return (
                  <td key={k} className={out ? "cell-out" : ""}>
                    {v === undefined ? "—" : formatMetric(k, v)}
                  </td>
                );
              })}
              <td className="note-cell">{m.note ?? ""}</td>
              <td className="row-actions">
                <button className="link-btn" onClick={() => onEdit(m)}>
                  编辑
                </button>
                <button
                  className="link-btn danger-text"
                  onClick={() =>
                    confirm.ask("删除该检测记录？删除后会进入回收站，可撤销。", () => remove([m.id]))
                  }
                >
                  删除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {confirm.node}
    </div>
  );
}

export function WaterChangeList({
  data,
  tankFilter,
  onEdit,
  onDeleted,
}: {
  data: AppData;
  tankFilter?: string;
  onEdit: (w: WaterChange) => void;
  onDeleted: (n: number, opId: string) => void;
}): JSX.Element {
  const confirm = useConfirm();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const rows = useMemo(
    () =>
      data.waterChanges
        .filter((w) => (tankFilter ? w.tankId === tankFilter : true))
        .sort((a, b) => Date.parse(b.time) - Date.parse(a.time)),
    [data, tankFilter],
  );
  const tankName = (id: string) => data.tanks.find((t) => t.id === id)?.name;
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const remove = (ids: string[]) => {
    const n = ids.length;
    const opId = store.deleteWaterChanges(ids);
    setSelected(new Set());
    onDeleted(n, opId);
  };
  if (rows.length === 0) return <p className="empty-hint">还没有换水记录。</p>;
  const allSelected = rows.every((r) => selected.has(r.id));
  return (
    <div className="table-wrap">
      <div className="batch-bar">
        <label className="check-all">
          <input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))} /> 全选
        </label>
        <button className="btn small danger" disabled={selected.size === 0} onClick={() => remove([...selected])}>
          删除选中（{selected.size}）
        </button>
      </div>
      <table className="data-table">
        <thead>
          <tr>
            <th className="col-check" />
            <th>时间</th>
            <th>鱼缸</th>
            <th>换水比例</th>
            <th>距上次</th>
            <th>备注</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((w, i) => {
            const prev = rows[i + 1];
            const gap = prev ? ((Date.parse(w.time) - Date.parse(prev.time)) / 86400000).toFixed(1) : "—";
            return (
              <tr key={w.id} className={selected.has(w.id) ? "selected" : ""}>
                <td className="col-check">
                  <input type="checkbox" checked={selected.has(w.id)} onChange={() => toggle(w.id)} />
                </td>
                <td className="nowrap">{fmtTime(w.time)}</td>
                <td>{tankName(w.tankId) ?? <span className="missing-ref">未知缸</span>}</td>
                <td>
                  <b>{w.percent}%</b>
                </td>
                <td>{gap === "—" ? "—" : `${gap} 天`}</td>
                <td className="note-cell">{w.note ?? ""}</td>
                <td className="row-actions">
                  <button className="link-btn" onClick={() => onEdit(w)}>
                    编辑
                  </button>
                  <button className="link-btn danger-text" onClick={() => confirm.ask("删除该换水记录？可撤销。", () => remove([w.id]))}>
                    删除
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {confirm.node}
    </div>
  );
}
