import { useMemo, useState } from "react";
import type { AppData, TodoItem } from "../core/types";
import { METRICS, formatMetric } from "../core/metrics";
import { buildContexts, generateTodos, latestExceedances, waterStatus, worseningTrends } from "../core/analysis";

const LEVEL_STYLE: Record<number, { cls: string; label: string }> = {
  3: { cls: "lv-critical", label: "紧急" },
  2: { cls: "lv-warning", label: "警告" },
  1: { cls: "lv-info", label: "提醒" },
};

export function Dashboard({ data, onJump }: { data: AppData; onJump: (tab: string, tankId?: string) => void }): JSX.Element {
  const now = Date.now();
  const todos = useMemo(() => generateTodos(data, now), [data]);
  const ctxs = useMemo(() => buildContexts(data), [data]);
  const counts = { 3: 0, 2: 0, 1: 0 } as Record<number, number>;
  todos.forEach((t) => counts[t.level]++);

  return (
    <div className="dash">
      <section className="panel">
        <div className="section-heading">
          <div>
            <p>维护待办</p>
            <h2>按 越界程度 × 恶化趋势 × 换水周期 综合生成</h2>
          </div>
          <span className="muted small">
            规则：越界 ≥15% 区间宽→警告，≥50%→紧急；连续 ≥2 次同向逼近→提醒（≥4 次升级）；超换水周期 1.5×→警告，2×→紧急
          </span>
        </div>
        <div className="todo-summary">
          <span className={`todo-count lv-critical ${counts[3] ? "" : "zero"}`}>紧急 {counts[3]}</span>
          <span className={`todo-count lv-warning ${counts[2] ? "" : "zero"}`}>警告 {counts[2]}</span>
          <span className={`todo-count lv-info ${counts[1] ? "" : "zero"}`}>提醒 {counts[1]}</span>
        </div>
        {todos.length === 0 ? (
          <div className="all-good">
            <div className="all-good-icon">✓</div>
            <p>所有在养缸当前无待办：指标均在安全区间、无连续恶化、换水未超期。</p>
          </div>
        ) : (
          <ul className="todo-list">
            {todos.map((t) => (
              <TodoCard key={t.id} todo={t} data={data} onJump={onJump} />
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <div className="section-heading">
          <div>
            <p>缸体速览</p>
            <h2>最近一次检测与换水状态</h2>
          </div>
        </div>
        <div className="tank-overview-grid">
          {ctxs.length === 0 && <p className="empty-hint">还没有在养鱼缸，到「鱼缸」页新增一个吧。</p>}
          {ctxs.map((c) => {
            const ws = waterStatus(c, now);
            const last = c.measurements.at(-1);
            const exc = latestExceedances(c.measurements, c.type);
            const trends = worseningTrends(c.measurements, c.type);
            return (
              <article key={c.tank.id} className="tank-card" onClick={() => onJump("records", c.tank.id)}>
                <header>
                  <h3>{c.tank.name}</h3>
                  <span className="tag">{c.type.name}</span>
                </header>
                {last ? (
                  <div className="tank-metrics">
                    {(Object.keys(METRICS) as (keyof typeof METRICS)[]).map((k) => {
                      const v = last.values[k];
                      const range = c.type.ranges[k];
                      const out = typeof v === "number" && range && (v < range.min || v > range.max);
                      return (
                        <div key={k} className={`mini-metric ${out ? "out" : ""}`}>
                          <span>{METRICS[k].label}</span>
                          <b>{v === undefined ? "—" : formatMetric(k, v)}</b>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="muted small">暂无检测记录</p>
                )}
                <footer>
                  <span className={ws.overdueRatio > 1 ? "wc-overdue" : ws.overdueRatio === Infinity ? "wc-none" : "wc-ok"}>
                    {ws.overdueRatio === Infinity
                      ? "从未换水"
                      : ws.overdueRatio > 1
                        ? `已 ${ws.daysSinceLast!.toFixed(1)} 天未换水（周期 ${ws.cycle} 天）`
                        : `上次换水 ${ws.daysSinceLast!.toFixed(1)} 天前 / 周期 ${ws.cycle} 天`}
                  </span>
                  {(exc.length > 0 || trends.length > 0) && (
                    <span className="tank-flag">
                      {exc.length > 0 && <b className="flag-out">{exc.length} 项越界</b>}
                      {trends.length > 0 && <b className="flag-trend">{trends.length} 项恶化</b>}
                    </span>
                  )}
                </footer>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function TodoCard({ todo, data, onJump }: { todo: TodoItem; data: AppData; onJump: (tab: string, tankId?: string) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const st = LEVEL_STYLE[todo.level];
  return (
    <li className={`todo-item ${st.cls}`}>
      <div className="todo-main">
        <span className={`level-badge ${st.cls}`}>{st.label}</span>
        <div className="todo-body">
          <h3>{todo.title}</h3>
          <p className="todo-first-reason">{todo.reasons[0]}</p>
          {open && (
            <ul className="todo-reasons">
              {todo.reasons.slice(1).map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
          {todo.reasons.length > 1 && (
            <button className="link-btn" onClick={() => setOpen((v) => !v)}>
              {open ? "收起判定依据" : `展开全部判定依据（${todo.reasons.length} 条）`}
            </button>
          )}
        </div>
        <div className="todo-side">
          <button className="btn small" onClick={() => onJump("records", todo.tankId)}>
            查看记录
          </button>
          <button className="btn small" onClick={() => onJump("trends", todo.tankId)}>
            看趋势
          </button>
        </div>
      </div>
    </li>
  );
}
