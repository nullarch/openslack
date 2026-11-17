import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { call, type Json } from '../../lib/api';
import { S } from '../../strings';
import { Spinner } from '../ui';

/**
 * Workspace analytics (client.admin.stats): a row of stat tiles, people active
 * per day, messages per day by kind of conversation, and tables per channel
 * and per person. Charts follow the data-viz rules: one hue for the single
 * series, three fixed categorical slots for the stack, thin columns with a
 * 2px surface gap, recessive hairline grid, a legend, hover tooltips and a
 * table view for every chart.
 */

interface Day {
  day: string;
  active: number;
  posting: number;
  messages: { public: number; private: number; direct: number };
}

interface Stats {
  days: number;
  summary: { members: number; joined: number; active: number; weekly_active: number; messages: number; public_share: number; files_uploaded: number; storage_bytes: number };
  series: Day[];
  channels: { id: string; name: string; is_private: boolean; messages: number; posters: number; members: number }[];
  members: { id: string; name: string; real_name: string; messages: number; days_active: number; last_active: string | null }[];
}

const KINDS = ['public', 'private', 'direct'] as const;

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat();
const shortDay = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size < 10 ? 1 : 0)} ${units[unit]}`;
}

/** Clean axis ticks: 0 and up to four round steps covering the maximum. */
function ticks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * power).find((candidate) => candidate >= rough) ?? 10 * power;
  const out: number[] = [];
  for (let value = 0; value <= max + step - 1e-9; value += step) out.push(Math.round(value));
  return out;
}

function tickLabel(value: number, top: number): string {
  return top >= 10_000 ? compact.format(value) : whole.format(value);
}

interface ColumnChartProps {
  title: string;
  days: Day[];
  /** One entry per stacked part, bottom first. */
  parts: { key: string; label: string; className: string; value: (day: Day) => number }[];
  /** Extra lines for the tooltip. */
  extra?: (day: Day) => string[];
}

function ColumnChart({ title, days, parts, extra }: ColumnChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  // Drawn at the plot's real width, so text and marks keep their size on any screen.
  const plot = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useLayoutEffect(() => {
    const element = plot.current;
    if (!element) return;
    const measure = (): void => setWidth(Math.max(240, Math.round(element.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [asTable]);
  const height = 180;
  const left = 40;
  const bottom = 22;
  const plotW = width - left - 8;
  const plotH = height - bottom - 8;
  const totals = days.map((day) => parts.reduce((sum, part) => sum + part.value(day), 0));
  const axis = ticks(Math.max(...totals, 0));
  const top = axis.at(-1)!;
  const band = plotW / Math.max(1, days.length);
  const barW = Math.max(2, Math.min(24, band - 2));
  const y = (value: number): number => 8 + plotH - (value / top) * plotH;
  // As many date labels as fit: about one per 80px.
  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor(plotW / 80))));

  return (
    <figure className="viz-card">
      <figcaption className="viz-head">
        <span className="viz-title">{title}</span>
        <button type="button" className="link-btn" onClick={() => setAsTable(!asTable)}>
          {asTable ? S.analytics.showChart : S.analytics.showTable}
        </button>
      </figcaption>
      {parts.length > 1 ? (
        <ul className="viz-legend">
          {parts.map((part) => (
            <li key={part.key}>
              <span className={`viz-swatch ${part.className}`} aria-hidden="true" />
              {part.label}
            </li>
          ))}
        </ul>
      ) : null}
      {asTable ? (
        <div className="viz-table-wrap">
          <table className="viz-table">
            <thead>
              <tr>
                <th>{S.analytics.day}</th>
                {parts.map((part) => (
                  <th key={part.key}>{part.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map((day) => (
                <tr key={day.day}>
                  <td>{shortDay.format(new Date(`${day.day}T00:00:00Z`))}</td>
                  {parts.map((part) => (
                    <td key={part.key}>{whole.format(part.value(day))}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="viz-plot" ref={plot} onMouseLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={title}>
            {axis.map((value) => (
              <g key={value}>
                <line className="viz-grid" x1={left} x2={width - 8} y1={y(value)} y2={y(value)} />
                <text className="viz-tick" x={left - 6} y={y(value) + 4} textAnchor="end">
                  {tickLabel(value, top)}
                </text>
              </g>
            ))}
            {days.map((day, index) => {
              const x = left + index * band + (band - barW) / 2;
              let base = 0;
              const segments = parts
                .map((part) => ({ part, value: part.value(day) }))
                .filter((segment) => segment.value > 0)
                .map((segment, position, all) => {
                  const from = base;
                  base += segment.value;
                  const yTop = y(base);
                  const yBottom = y(from) - (position > 0 ? 2 : 0); // 2px surface gap between segments
                  const h = Math.max(0, yBottom - yTop);
                  const last = position === all.length - 1;
                  const r = last ? Math.min(4, barW / 2, h) : 0;
                  // Rounded data end on the top segment only; square at the baseline.
                  const d = `M${x},${yBottom} L${x},${yTop + r} Q${x},${yTop} ${x + r},${yTop} L${x + barW - r},${yTop} Q${x + barW},${yTop} ${x + barW},${yTop + r} L${x + barW},${yBottom} Z`;
                  return <path key={segment.part.key} className={`viz-mark ${segment.part.className}`} d={d} />;
                });
              return (
                <g key={day.day} className={hover === index ? 'is-hover' : ''}>
                  {segments}
                  <rect className="viz-hit" x={left + index * band} y={8} width={band} height={plotH} onMouseEnter={() => setHover(index)} onFocus={() => setHover(index)} tabIndex={-1} />
                  {index % labelEvery === 0 ? (
                    <text className="viz-tick" x={left + index * band + band / 2} y={height - 6} textAnchor="middle">
                      {shortDay.format(new Date(`${day.day}T00:00:00Z`))}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </svg>
          {hover !== null && days[hover] ? (
            <div className="viz-tooltip" style={{ left: `${((left + hover * band + band / 2) / width) * 100}%` }} role="status">
              <strong>{shortDay.format(new Date(`${days[hover]!.day}T00:00:00Z`))}</strong>
              {parts.map((part) => (
                <span key={part.key} className="viz-tooltip-row">
                  {parts.length > 1 ? <span className={`viz-swatch ${part.className}`} aria-hidden="true" /> : null}
                  {part.label} <b>{whole.format(part.value(days[hover]!))}</b>
                </span>
              ))}
              {extra?.(days[hover]!).map((line) => (
                <span key={line} className="viz-tooltip-row">
                  {line}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </figure>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="stat-tile">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {note ? <span className="stat-note">{note}</span> : null}
    </div>
  );
}

export function AnalyticsAdmin() {
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<Stats | null>(null);
  const [failed, setFailed] = useState(false);
  const [allChannels, setAllChannels] = useState(false);
  const [allMembers, setAllMembers] = useState(false);

  useEffect(() => {
    setStats(null);
    call('client.admin.stats', { days })
      .then((result: Json) => setStats(result as unknown as Stats))
      .catch(() => setFailed(true));
  }, [days]);

  const kinds = useMemo(
    () =>
      KINDS.map((kind, index) => ({
        key: kind,
        label: S.analytics.kinds[kind],
        className: `viz-s${index + 1}`,
        value: (day: Day) => day.messages[kind],
      })),
    [],
  );

  if (failed) return <p className="notice">{S.analytics.unavailable}</p>;
  if (!stats) return <Spinner />;
  const { summary } = stats;
  const channels = allChannels ? stats.channels : stats.channels.slice(0, 8);
  const members = allMembers ? stats.members : stats.members.slice(0, 8);

  return (
    <div className="analytics">
      <div className="analytics-range" role="radiogroup" aria-label={S.analytics.range}>
        {[7, 30, 90].map((value) => (
          <button key={value} type="button" role="radio" aria-checked={days === value} className={days === value ? 'is-active' : ''} onClick={() => setDays(value)}>
            {S.analytics.lastDays(value)}
          </button>
        ))}
      </div>
      <div className="stat-row">
        <Tile label={S.analytics.members} value={whole.format(summary.members)} note={summary.joined ? S.analytics.joined(summary.joined) : undefined} />
        <Tile label={S.analytics.active} value={whole.format(summary.active)} note={S.analytics.weekly(summary.weekly_active)} />
        <Tile label={S.analytics.messages} value={compact.format(summary.messages)} note={S.analytics.publicShare(summary.public_share)} />
        <Tile label={S.analytics.files} value={whole.format(summary.files_uploaded)} note={S.analytics.storage(bytes(summary.storage_bytes))} />
      </div>
      <ColumnChart
        title={S.analytics.activeChart}
        days={stats.series}
        parts={[{ key: 'active', label: S.analytics.activePeople, className: 'viz-single', value: (day) => day.active }]}
        extra={(day) => [S.analytics.postingPeople(day.posting)]}
      />
      <ColumnChart title={S.analytics.messagesChart} days={stats.series} parts={kinds} />

      <h3 className="dialog-sub">{S.analytics.channels}</h3>
      <table className="viz-table">
        <thead>
          <tr>
            <th>{S.analytics.channel}</th>
            <th>{S.analytics.messages}</th>
            <th>{S.analytics.posters}</th>
            <th>{S.analytics.membersCol}</th>
          </tr>
        </thead>
        <tbody>
          {channels.map((row) => (
            <tr key={row.id}>
              <td>{row.is_private ? '🔒 ' : '#'}{row.name}</td>
              <td>{whole.format(row.messages)}</td>
              <td>{whole.format(row.posters)}</td>
              <td>{whole.format(row.members)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {stats.channels.length > 8 ? (
        <button type="button" className="link-btn" onClick={() => setAllChannels(!allChannels)}>
          {allChannels ? S.analytics.showFewer : S.analytics.showAll(stats.channels.length)}
        </button>
      ) : null}

      <h3 className="dialog-sub">{S.analytics.people}</h3>
      <table className="viz-table">
        <thead>
          <tr>
            <th>{S.analytics.person}</th>
            <th>{S.analytics.messages}</th>
            <th>{S.analytics.daysActive}</th>
            <th>{S.analytics.lastActive}</th>
          </tr>
        </thead>
        <tbody>
          {members.map((row) => (
            <tr key={row.id}>
              <td>{row.real_name || row.name}</td>
              <td>{whole.format(row.messages)}</td>
              <td>{whole.format(row.days_active)}</td>
              <td>{row.last_active ? shortDay.format(new Date(`${row.last_active}T00:00:00Z`)) : S.analytics.never}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {stats.members.length > 8 ? (
        <button type="button" className="link-btn" onClick={() => setAllMembers(!allMembers)}>
          {allMembers ? S.analytics.showFewer : S.analytics.showAll(stats.members.length)}
        </button>
      ) : null}
    </div>
  );
}
