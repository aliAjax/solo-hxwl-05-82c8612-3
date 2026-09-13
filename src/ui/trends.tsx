import { useMemo, useState } from "react";
import type { AppData, MetricKey, Tank } from "../core/types";
import { METRICS, formatMetric } from "../core/metrics";
import { buildContexts, buildSeries, type TrendSeries } from "../core/analysis";

const TANK_COLORS = ["#0891b2", "#7c3aed", "#ea580c", "#16a34a", "#db2777", "#ca8a04", "#0284c7", "#dc2626"];

const PRESETS: { label: string; days: number | null }[] = [
  { label: "7 天", days: 7 },
  { label: "30 天", days: 30 },
  { label: "90 天", days: 90 },
  { label: "全部", days: null },
];

function toDateInput(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function TrendView({ data }: { data: AppData }): JSX.Element {
  const [metric, setMetric] = useState<MetricKey>("nitrate");
  const [preset, setPreset] = useState<number | null>(30);
  const [fromInput, setFromInput] = useState("");
  const [toInput, setToInput] = useState("");
  const activeTanks0 = useMemo(() => data.tanks.filter((t) => !t.archived).map((t) => t.id), [data.tanks]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // 有数据的缸才参与默认勾选
  const selectable = activeTanks0;
  const selectedIds = selectable.filter((id) => picked.size === 0 || picked.has(id));
  const toggleTank = (id: string) =>
    setPicked((s) => {
      const base = s.size === 0 ? new Set(selectable) : new Set(s);
      base.has(id) ? base.delete(id) : base.add(id);
      return base;
    });

  const now = Date.now();
  const from = fromInput ? Date.parse(fromInput + "T00:00") : preset ? now - preset * 86400000 : undefined;
  const to = toInput ? Date.parse(toInput + "T23:59") : undefined;

  const ctxs = useMemo(
    () => buildContexts(data).filter((c) => selectedIds.includes(c.tank.id)),
    [data, picked, preset, fromInput, toInput, metric], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const allSeries = useMemo(() => buildSeries(ctxs, metric, from, to), [ctxs, metric, from, to]);
  const def = METRICS[metric];

  const tankName = (id: string) => data.tanks.find((t) => t.id === id)?.name ?? id;
  const typeOf = (id: string) => data.tankTypes.find((tt) => tt.id === data.tanks.find((t) => t.id === id)?.typeId);

  // 合并所有缸的区间（取并集展示，各缸区间相同时一条带）
  const ranges = new Map<string, { min: number; max: number }>();
  for (const c of ctxs) {
    const r = c.type.ranges[metric];
    if (r) ranges.set(`${r.min}|${r.max}`, r);
  }
  const rangeBands = [...ranges.values()];

  const anomalies = allSeries.flatMap((s) => s.points.filter((p) => p.anomalous).map((p) => ({ ...p, tankId: s.tankId })));
  const anyData = allSeries.some((s) => s.points.length > 0);

  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <p>趋势分析</p>
          <h2>多缸对比与异常定位</h2>
        </div>
      </div>

      <div className="trend-controls">
        <div className="control-group">
          <span className="ctl-label">指标</span>
          <select className="input small" value={metric} onChange={(e) => setMetric(e.target.value as MetricKey)}>
            {(Object.keys(METRICS) as MetricKey[]).map((k) => (
              <option key={k} value={k}>
                {METRICS[k].label}（{METRICS[k].unit || "无单位"}）
              </option>
            ))}
          </select>
        </div>
        <div className="control-group">
          <span className="ctl-label">时间</span>
          <div className="preset-row">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                className={`chip-btn ${!fromInput && !toInput && preset === p.days ? "active" : ""}`}
                onClick={() => {
                  setPreset(p.days);
                  setFromInput("");
                  setToInput("");
                }}
              >
                {p.label}
              </button>
            ))}
            <input type="date" className="input tiny" value={fromInput} onChange={(e) => setFromInput(e.target.value)} title="起始日期" />
            <span>~</span>
            <input type="date" className="input tiny" value={toInput} onChange={(e) => setToInput(e.target.value)} title="结束日期" />
          </div>
        </div>
        <div className="control-group tanks-pick">
          <span className="ctl-label">鱼缸</span>
          {selectable.map((id, i) => (
            <button
              key={id}
              className={`legend-chip ${selectedIds.includes(id) ? "active" : ""}`}
              style={{ ["--c" as string]: TANK_COLORS[i % TANK_COLORS.length] }}
              onClick={() => toggleTank(id)}
            >
              <i className="dot" />
              {tankName(id)}
            </button>
          ))}
        </div>
      </div>

      {anyData ? (
        <Chart
          series={allSeries}
          bands={rangeBands}
          unit={def.unit}
          precision={def.precision}
          colorOf={(tankId) => TANK_COLORS[selectable.indexOf(tankId) % TANK_COLORS.length]}
          tankName={tankName}
        />
      ) : (
        <p className="empty-hint">所选时间范围内没有该指标的数据。</p>
      )}

      <div className="anomaly-block">
        <h4>
          异常点定位
          <span className="muted">（越界 / 相邻突变 &gt;40% 区间宽 / 偏离中位数 &gt;3×MAD）</span>
          <b className={anomalies.length ? "anom-count" : "anom-count zero"}>{anomalies.length}</b>
        </h4>
        {anomalies.length === 0 ? (
          <p className="muted">未发现异常点。</p>
        ) : (
          <ul className="anomaly-list">
            {anomalies
              .sort((a, b) => b.time - a.time)
              .map((a) => (
                <li key={a.measurementId}>
                  <span className="anom-dot" style={{ background: TANK_COLORS[selectable.indexOf(a.tankId) % TANK_COLORS.length] }} />
                  <b>{tankName(a.tankId)}</b>
                  <span>
                    {new Date(a.time).toLocaleString("zh-CN", { hour12: false })}
                  </span>
                  <b className="anom-value">{formatMetric(metric, a.value)}</b>
                  <span className="anom-reason">{a.reason}</span>
                  <span className="muted">缸型区间：{(() => {
                    const r = typeOf(a.tankId)?.ranges[metric];
                    return r ? `${r.min}~${r.max}${def.unit}` : "未设置";
                  })()}</span>
                </li>
              ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Chart({
  series,
  bands,
  unit,
  precision,
  colorOf,
  tankName,
}: {
  series: TrendSeries[];
  bands: { min: number; max: number }[];
  unit: string;
  precision: number;
  colorOf: (tankId: string) => string;
  tankName: (id: string) => string;
}): JSX.Element {
  const [hover, setHover] = useState<{ sid: number; pid: number } | null>(null);
  const W = 920;
  const H = 340;
  const PAD_L = 56;
  const PAD_R = 16;
  const PAD_T = 18;
  const PAD_B = 40;
  const iw = W - PAD_L - PAD_R;
  const ih = H - PAD_T - PAD_B;

  const allPoints = series.flatMap((s) => s.points);
  const times = allPoints.map((p) => p.time);
  let tMin = Math.min(...times);
  let tMax = Math.max(...times);
  if (tMin === tMax) {
    tMin -= 3600000;
    tMax += 3600000;
  }
  let vMin = Math.min(...allPoints.map((p) => p.value), ...bands.map((b) => b.min));
  let vMax = Math.max(...allPoints.map((p) => p.value), ...bands.map((b) => b.max));
  const padV = (vMax - vMin) * 0.12 || 1;
  vMin -= padV;
  vMax += padV;
  // 本应用所有指标物理下限为 0，纵轴不出现无意义的负值
  if (allPoints.every((p) => p.value >= 0) && bands.every((b) => b.min >= 0)) vMin = Math.max(0, vMin);

  const x = (t: number) => PAD_L + ((t - tMin) / (tMax - tMin)) * iw;
  const y = (v: number) => PAD_T + (1 - (v - vMin) / (vMax - vMin)) * ih;

  // y 轴刻度
  const ticks = Array.from({ length: 5 }, (_, i) => vMin + ((vMax - vMin) * i) / 4);
  const xTicks = Array.from({ length: 6 }, (_, i) => tMin + ((tMax - tMin) * i) / 5);

  const hovered = hover ? series[hover.sid]?.points[hover.pid] : null;

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="trend-svg" onMouseLeave={() => setHover(null)}>
        {/* 安全区间带（多区间时半透明叠加） */}
        {bands.map((b, i) => (
          <rect
            key={i}
            x={PAD_L}
            y={y(b.max)}
            width={iw}
            height={Math.max(0, y(b.min) - y(b.max))}
            className="safe-band"
          />
        ))}
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(v)} y2={y(v)} className="grid-line" />
            <text x={PAD_L - 8} y={y(v) + 4} textAnchor="end" className="axis-text">
              {v.toFixed(precision)}
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={i} x={x(t)} y={H - PAD_B + 18} textAnchor="middle" className="axis-text">
            {new Date(t).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })}
          </text>
        ))}

        {series.map((s, si) => {
          if (s.points.length === 0) return null;
          const color = colorOf(s.tankId);
          const path = s.points.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.time).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
          return (
            <g key={s.tankId}>
              {s.points.length > 1 && <path d={path} fill="none" stroke={color} strokeWidth={2.2} className="series-line" />}
              {s.points.map((p, pi) => (
                <circle
                  key={p.measurementId}
                  cx={x(p.time)}
                  cy={y(p.value)}
                  r={p.anomalous ? 5.5 : 3.2}
                  className={p.anomalous ? "point-anom" : "point"}
                  stroke={color}
                  fill={p.anomalous ? "#fff" : color}
                  onMouseEnter={() => setHover({ sid: si, pid: pi })}
                />
              ))}
            </g>
          );
        })}
      </svg>
      <div className="chart-legend">
        {series.map((s, i) => (
          <span key={s.tankId} className="legend-chip static" style={{ ["--c" as string]: colorOf(s.tankId) }}>
            <i className="dot" />
            {tankName(s.tankId)}
            <em>{s.points.length} 点</em>
          </span>
        ))}
        <span className="legend-band">▭ 安全区间</span>
      </div>
      {hovered && hover && (
        <div
          className="chart-tip"
          style={{
            left: `${(x(hovered.time) / W) * 100}%`,
            top: `${(y(hovered.value) / H) * 100}%`,
          }}
        >
          <b>{tankName(series[hover.sid].tankId)}</b>
          <div>
            {formatMetric(series[hover.sid].metric, hovered.value)}
          </div>
          <div className="muted">{new Date(hovered.time).toLocaleString("zh-CN", { hour12: false })}</div>
          {hovered.anomalous && <div className="anom-reason">{hovered.reason}</div>}
        </div>
      )}
    </div>
  );
}
