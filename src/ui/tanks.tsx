import { useState } from "react";
import type { MetricKey, Tank, TankType } from "../core/types";
import { METRICS, METRIC_KEYS } from "../core/metrics";
import { store } from "../core/store";
import { Field, Modal, TextInput, useConfirm } from "./widgets";

function RangeEditor({
  metric,
  value,
  onChange,
}: {
  metric: MetricKey;
  value?: { min: number; max: number };
  onChange: (v: { min: number; max: number } | undefined) => void;
}): JSX.Element {
  const def = METRICS[metric];
  const [enabled, setEnabled] = useState(!!value);
  const [min, setMin] = useState(value ? String(value.min) : "");
  const [max, setMax] = useState(value ? String(value.max) : "");
  const p = def.physical;
  const nMin = Number(min);
  const nMax = Number(max);
  const err =
    enabled && min !== "" && max !== "" && (Number.isNaN(nMin) || Number.isNaN(nMax) || nMin > nMax || nMin < p.min || nMax > p.max)
      ? `需为 ${p.min}~${p.max} 内数字且下限≤上限`
      : undefined;

  const commit = (en: boolean, lo: string, hi: string) => {
    if (!en || lo === "" || hi === "" || Number.isNaN(Number(lo)) || Number.isNaN(Number(hi)) || Number(lo) > Number(hi)) {
      onChange(undefined);
      return;
    }
    onChange({ min: Number(lo), max: Number(hi) });
  };

  return (
    <div className={`range-row ${err ? "has-error" : ""}`}>
      <label className="range-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            commit(e.target.checked, min, max);
          }}
        />
        <span>
          {def.label}
          <em>{def.unit || "无单位"}</em>
        </span>
      </label>
      {enabled && (
        <div className="range-inputs">
          <input
            className="input tiny"
            value={min}
            placeholder="下限"
            onChange={(e) => {
              setMin(e.target.value);
              commit(true, e.target.value, max);
            }}
          />
          <span>~</span>
          <input
            className="input tiny"
            value={max}
            placeholder="上限"
            onChange={(e) => {
              setMax(e.target.value);
              commit(true, min, e.target.value);
            }}
          />
          {err && <span className="field-error">{err}</span>}
        </div>
      )}
    </div>
  );
}

export function TypeEditorModal({
  open,
  onClose,
  editing,
}: {
  open: boolean;
  onClose: () => void;
  editing: TankType | null;
}): JSX.Element {
  const [name, setName] = useState(editing?.name ?? "");
  const [cycle, setCycle] = useState(String(editing?.waterChangeCycleDays ?? 7));
  const [ranges, setRanges] = useState<TankType["ranges"]>(() => structuredClone(editing?.ranges ?? {}));
  const nameErr = !name.trim() ? "请填写缸型名称" : undefined;
  const cycleErr = Number(cycle) <= 0 || Number(cycle) > 365 || Number.isNaN(Number(cycle)) ? "1~365 天" : undefined;

  // 每次 open 切换时重新初始化（editing 变化即重建组件即可，见 key）
  const save = () => {
    if (nameErr || cycleErr) return;
    if (editing) store.updateType(editing.id, { name: name.trim(), waterChangeCycleDays: Number(cycle), ranges });
    else store.addType({ name: name.trim(), waterChangeCycleDays: Number(cycle), ranges });
    onClose();
  };

  return (
    <Modal
      open={open}
      wide
      title={editing ? `编辑缸型：${editing.name}` : "新增缸型"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={save} disabled={!!nameErr || !!cycleErr}>
            保存
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="缸型名称" error={nameErr}>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="如：原生缸" />
        </Field>
        <Field label="建议换水周期（天）" error={cycleErr}>
          <TextInput type="number" min={1} max={365} value={cycle} onChange={(e) => setCycle(e.target.value)} />
        </Field>
      </div>
      <h4 className="range-head">各指标安全区间（勾选启用；边界值视为安全）</h4>
      <div className="range-grid">
        {METRIC_KEYS.map((k) => (
          <RangeEditor
            key={k}
            metric={k}
            value={ranges[k]}
            onChange={(v) => setRanges((r) => ({ ...r, [k]: v }))}
          />
        ))}
      </div>
      {editing?.builtin && <p className="form-note">内置缸型被修改后将另存为自定义阈值，不影响其它缸型。</p>}
    </Modal>
  );
}

export function TankEditorModal({
  open,
  onClose,
  editing,
  types,
}: {
  open: boolean;
  onClose: () => void;
  editing: Tank | null;
  types: TankType[];
}): JSX.Element {
  const [name, setName] = useState(editing?.name ?? "");
  const [typeId, setTypeId] = useState(editing?.typeId ?? types[0]?.id ?? "");
  const [volume, setVolume] = useState(editing?.volumeLiters !== undefined ? String(editing.volumeLiters) : "");
  const [note, setNote] = useState(editing?.note ?? "");
  const nameErr = !name.trim() ? "请填写鱼缸名称" : undefined;
  const volErr = volume !== "" && (Number.isNaN(Number(volume)) || Number(volume) <= 0) ? "需为正数（升）" : undefined;

  const save = () => {
    if (nameErr || volErr || !typeId) return;
    const payload = { name: name.trim(), typeId, volumeLiters: volume === "" ? undefined : Number(volume), note: note.trim() || undefined };
    if (editing) store.updateTank(editing.id, payload);
    else store.addTank(payload);
    onClose();
  };

  return (
    <Modal
      open={open}
      title={editing ? `编辑鱼缸：${editing.name}` : "新增鱼缸"}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={save} disabled={!!nameErr || !!volErr || !typeId}>
            保存
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="鱼缸名称" error={nameErr}>
          <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="如：客厅草缸" />
        </Field>
        <Field label="缸型（决定安全区间与换水周期）">
          <select className="input" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}（{t.waterChangeCycleDays} 天周期{!t.builtin ? " · 自定义" : ""}）
              </option>
            ))}
          </select>
        </Field>
        <Field label="体积（升，可选）" error={volErr}>
          <TextInput type="number" value={volume} onChange={(e) => setVolume(e.target.value)} placeholder="如 60" />
        </Field>
        <Field label="备注">
          <TextInput value={note ?? ""} onChange={(e) => setNote(e.target.value)} placeholder="位置、鱼种等" />
        </Field>
      </div>
    </Modal>
  );
}

export function TankTypeManager({
  types,
  onAdd,
  onEdit,
}: {
  types: TankType[];
  onAdd: () => void;
  onEdit: (t: TankType) => void;
}): JSX.Element {
  const confirm = useConfirm();
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>阈值模板</p>
          <h2>缸型与安全区间</h2>
        </div>
        <button className="btn primary" onClick={onAdd}>
          ＋ 新增缸型
        </button>
      </div>
      <div className="type-grid">
        {types.map((t) => (
          <article key={t.id} className="type-card">
            <header>
              <h3>
                {t.name} {!t.builtin && <span className="tag">自定义</span>}
              </h3>
              <div className="row-actions">
                <button className="link-btn" onClick={() => onEdit(t)}>
                  编辑
                </button>
                <button
                  className="link-btn danger-text"
                  onClick={() =>
                    confirm.ask(`确定删除缸型「${t.name}」？使用该缸型的鱼缸需重新指定缸型（此操作可撤销）。`, () =>
                      store.deleteType(t.id),
                    )
                  }
                >
                  删除
                </button>
              </div>
            </header>
            <p className="muted">换水周期 {t.waterChangeCycleDays} 天</p>
            <ul className="range-list">
              {METRIC_KEYS.filter((k) => t.ranges[k]).map((k) => (
                <li key={k}>
                  {METRICS[k].label}
                  <b>
                    {t.ranges[k]!.min}~{t.ranges[k]!.max}
                    {METRICS[k].unit}
                  </b>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
      {confirm.node}
    </section>
  );
}
