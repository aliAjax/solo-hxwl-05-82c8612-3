import { useEffect, useMemo, useState } from "react";
import "./styles.css";
import type { AppData, Measurement, Tank, TankType, WaterChange } from "./core/types";
import { store, useStore } from "./core/store";
import { METRICS, METRIC_KEYS } from "./core/metrics";
import { downloadText } from "./core/exporter";
import { Dashboard } from "./ui/dashboard";
import { TrendView } from "./ui/trends";
import { TankEditorModal, TankTypeManager, TypeEditorModal } from "./ui/tanks";
import { MeasurementList, MeasurementModal, WaterChangeList, WaterChangeModal } from "./ui/records";
import { SettingsView } from "./ui/settings";
import { Toasts, useToasts, useUndoHotkeys } from "./ui/toast";
import { useConfirm } from "./ui/widgets";

type Tab = "dashboard" | "tanks" | "records" | "trends" | "settings";
type ToastFn = (t: string, action?: { label: string; run: () => void }) => void;
/** 弹窗三态：关闭 / 新建 / 编辑某条 */
type EditState<T> = { mode: "new" } | { mode: "edit"; item: T } | null;

const TABS: { key: Tab; label: string }[] = [
  { key: "dashboard", label: "工作台" },
  { key: "tanks", label: "鱼缸与缸型" },
  { key: "records", label: "检测 / 换水" },
  { key: "trends", label: "趋势" },
  { key: "settings", label: "导入导出 / 设置" },
];

function StartupNotice({ onClose }: { onClose: () => void }): JSX.Element | null {
  const n = store.notice;
  const [show, setShow] = useState(true);
  if (!show || (n.issues.length === 0 && n.quarantined.length === 0)) return null;
  return (
    <div className="notice-banner">
      <div className="notice-head">
        <b>⚠ 检测到本地存储存在损坏数据（{n.issues.length} 处问题，{n.quarantined.length} 段被隔离）</b>
        <button
          className="icon-btn"
          onClick={() => {
            setShow(false);
            onClose();
          }}
        >
          ✕
        </button>
      </div>
      <p className="notice-desc">损坏片段已被隔离，不影响其余数据与正常使用。以下记录被跳过或部分清洗：</p>
      <ul className="issue-list compact">
        {n.issues.slice(0, 20).map((i, idx) => (
          <li key={idx}>
            <code className="issue-path">{i.path}</code>
            <span>{i.message}</span>
          </li>
        ))}
        {n.issues.length > 20 && <li>…其余 {n.issues.length - 20} 条已省略</li>}
      </ul>
      {n.quarantined.length > 0 && (
        <div className="btn-row">
          {n.quarantined.map((q, i) => (
            <button key={i} className="btn small ghost" onClick={() => downloadText(`quarantined-${q.key.replace(/[^\w]/g, "_")}.txt`, q.raw)}>
              下载隔离原文（{q.key}）
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TankManager({ toast }: { toast: ToastFn }): JSX.Element {
  const data = useStore();
  const confirm = useConfirm();
  const [tankState, setTankState] = useState<EditState<Tank>>(null);
  const [typeState, setTypeState] = useState<EditState<TankType>>(null);
  const [showArchived, setShowArchived] = useState(false);
  const typeOf = (id: string) => data.tankTypes.find((t) => t.id === id);
  const visible = data.tanks.filter((t) => t.archived === showArchived);

  return (
    <>
      <section className="panel">
        <div className="section-heading">
          <div>
            <p>鱼缸管理</p>
            <h2>
              {showArchived ? "已归档鱼缸" : "在养鱼缸"}（{visible.length}）
            </h2>
          </div>
          <div className="btn-row">
            <button className="btn ghost" onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? "查看在养缸" : "查看归档缸"}
            </button>
            <button className="btn primary" onClick={() => setTankState({ mode: "new" })}>
              ＋ 新增鱼缸
            </button>
          </div>
        </div>
        {visible.length === 0 && <p className="empty-hint">{showArchived ? "没有已归档的鱼缸。" : "还没有鱼缸，点击右上角新增。"}</p>}
        <div className="tank-manage-grid">
          {visible.map((tank) => {
            const type = typeOf(tank.typeId);
            const mCount = data.measurements.filter((m) => m.tankId === tank.id).length;
            const wCount = data.waterChanges.filter((w) => w.tankId === tank.id).length;
            return (
              <article key={tank.id} className="tank-manage-card">
                <header>
                  <h3>{tank.name}</h3>
                  <span className={`tag ${type ? "" : "tag-warn"}`}>{type ? type.name : "缸型缺失"}</span>
                </header>
                <p className="muted small">
                  {tank.volumeLiters ? `${tank.volumeLiters} L · ` : ""}
                  {mCount} 条检测 · {wCount} 条换水{tank.note ? ` · ${tank.note}` : ""}
                </p>
                {type && (
                  <ul className="range-list compact">
                    {METRIC_KEYS.filter((k) => type.ranges[k]).map((k) => (
                      <li key={k}>
                        {METRICS[k].label}
                        <b>
                          {type.ranges[k]!.min}~{type.ranges[k]!.max}
                          {METRICS[k].unit}
                        </b>
                      </li>
                    ))}
                  </ul>
                )}
                <footer className="card-actions">
                  <button className="link-btn" onClick={() => setTankState({ mode: "edit", item: tank })}>
                    编辑
                  </button>
                  {showArchived ? (
                    <>
                      <button className="link-btn" onClick={() => store.setArchived(tank.id, false)}>
                        恢复在养
                      </button>
                      <button
                        className="link-btn danger-text"
                        onClick={() =>
                          confirm.ask(`彻底删除「${tank.name}」及其全部检测/换水记录？记录会进入回收站，整体操作可撤销。`, () => {
                            store.purgeTank(tank.id);
                            toast("鱼缸已彻底删除（记录进入回收站）", { label: "撤销", run: () => store.undo() });
                          })
                        }
                      >
                        彻底删除
                      </button>
                    </>
                  ) : (
                    <button
                      className="link-btn"
                      onClick={() =>
                        confirm.ask(`归档「${tank.name}」？归档后不参与待办与趋势，数据保留并可随时恢复。`, () => store.setArchived(tank.id, true))
                      }
                    >
                      归档
                    </button>
                  )}
                </footer>
              </article>
            );
          })}
        </div>
        {confirm.node}
      </section>

      <TankTypeManager
        types={data.tankTypes}
        onAdd={() => setTypeState({ mode: "new" })}
        onEdit={(t) => setTypeState({ mode: "edit", item: t })}
      />

      {tankState && (
        <TankEditorModal
          key={tankState.mode === "edit" ? tankState.item.id : "new"}
          open
          onClose={() => setTankState(null)}
          editing={tankState.mode === "edit" ? tankState.item : null}
          types={data.tankTypes}
        />
      )}
      {typeState?.mode === "new" || typeState?.mode === "edit" ? (
        <TypeEditorModal key={typeState.mode === "edit" ? typeState.item.id : "new-type"} open onClose={() => setTypeState(null)} editing={typeState.mode === "edit" ? typeState.item : null} />
      ) : null}
    </>
  );
}

function RecordsPage({ focusTank, toast }: { focusTank?: string; toast: ToastFn }): JSX.Element {
  const data = useStore();
  const [kind, setKind] = useState<"meas" | "wc">("meas");
  const [tankFilter, setTankFilter] = useState<string>(focusTank ?? "");
  const [measState, setMeasState] = useState<EditState<Measurement>>(null);
  const [wcState, setWcState] = useState<EditState<WaterChange>>(null);
  const activeTanks = data.tanks.filter((t) => !t.archived);

  useEffect(() => {
    if (focusTank) setTankFilter(focusTank);
  }, [focusTank]);

  return (
    <>
      <section className="panel">
        <div className="section-heading">
          <div className="kind-switch">
            <button className={`seg ${kind === "meas" ? "active" : ""}`} onClick={() => setKind("meas")}>
              检测记录（数值 · 时间）
            </button>
            <button className={`seg ${kind === "wc" ? "active" : ""}`} onClick={() => setKind("wc")}>
              换水记录（比例 · 备注）
            </button>
          </div>
          <div className="btn-row">
            <select className="input small" value={tankFilter} onChange={(e) => setTankFilter(e.target.value)}>
              <option value="">全部在养缸</option>
              {activeTanks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            {kind === "meas" ? (
              <button className="btn primary" onClick={() => setMeasState({ mode: "new" })}>
                ＋ 新增检测
              </button>
            ) : (
              <button className="btn primary" onClick={() => setWcState({ mode: "new" })}>
                ＋ 登记换水
              </button>
            )}
          </div>
        </div>
        {kind === "meas" ? (
          <MeasurementList
            data={data}
            tankFilter={tankFilter || undefined}
            onEdit={(m) => setMeasState({ mode: "edit", item: m })}
            onDeleted={(n) =>
              toast(`已删除 ${n} 条检测记录（可在回收站/撤销中恢复）`, { label: "撤销删除", run: () => store.undo() })
            }
          />
        ) : (
          <WaterChangeList
            data={data}
            tankFilter={tankFilter || undefined}
            onEdit={(w) => setWcState({ mode: "edit", item: w })}
            onDeleted={(n) => toast(`已删除 ${n} 条换水记录`, { label: "撤销删除", run: () => store.undo() })}
          />
        )}
      </section>

      {measState && (
        <MeasurementModal
          key={measState.mode === "edit" ? measState.item.id : "new"}
          open
          onClose={() => setMeasState(null)}
          data={data}
          editing={measState.mode === "edit" ? measState.item : null}
          defaultTankId={tankFilter || activeTanks[0]?.id}
        />
      )}
      {wcState && (
        <WaterChangeModal
          key={wcState.mode === "edit" ? wcState.item.id : "new"}
          open
          onClose={() => setWcState(null)}
          data={data}
          editing={wcState.mode === "edit" ? wcState.item : null}
          defaultTankId={tankFilter || activeTanks[0]?.id}
        />
      )}
    </>
  );
}

function OfflineBadge(): JSX.Element {
  const [online, setOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return <span className={`offline-badge ${online ? "on" : "off"}`}>{online ? "● 在线（已支持离线）" : "● 离线模式"}</span>;
}

export default function App(): JSX.Element {
  const data = useStore();
  const { toasts, push, dismiss } = useToasts();
  useUndoHotkeys();
  const [tab, setTab] = useState<Tab>("dashboard");
  const [focusTank, setFocusTank] = useState<string | undefined>(undefined);

  const jump = (t: string, tankId?: string) => {
    setFocusTank(tankId);
    setTab(t as Tab);
  };

  const archivedCount = useMemo(() => data.tanks.filter((t) => t.archived).length, [data.tanks]);

  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <span className="brand-icon">
            <svg viewBox="0 0 48 48" width="38" height="38" aria-hidden="true">
              <path d="M24 5c8 9 13 16 13 22a13 13 0 1 1-26 0c0-6 5-13 13-22z" fill="#0891b2" opacity="0.15" />
              <path d="M24 9c7 8 11 14 11 19a11 11 0 1 1-22 0c0-5 4-11 11-19z" fill="#0891b2" />
              <circle cx="19" cy="25" r="2.1" fill="#fff" />
            </svg>
          </span>
          <div>
            <h1>多鱼缸水质工作台</h1>
            <p>离线可用 · 阈值安全区间 · 趋势与换水待办</p>
          </div>
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.key} className={`tab ${tab === t.key ? "active" : ""}`} onClick={() => setTab(t.key)}>
              {t.label}
              {t.key === "tanks" && archivedCount > 0 && <span className="tab-badge">{archivedCount}</span>}
            </button>
          ))}
        </nav>
      </header>

      <StartupNotice onClose={() => store.clearNotice()} />

      {tab === "dashboard" && <Dashboard data={data} onJump={jump} />}
      {tab === "tanks" && <TankManager toast={push} />}
      {tab === "records" && <RecordsPage focusTank={focusTank} toast={push} />}
      {tab === "trends" && <TrendView data={data} />}
      {tab === "settings" && <SettingsView data={data} toast={push} />}

      <footer className="app-footer">
        <span>数据仅存于本浏览器 · 断网可用 · 支持 Ctrl/⌘+Z 撤销、Ctrl/⌘+Y 重做</span>
        <OfflineBadge />
      </footer>

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </main>
  );
}
