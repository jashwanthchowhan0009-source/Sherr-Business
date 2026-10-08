'use client';

import { useState, type ReactNode } from 'react';
import { axisLabel, niceDomain } from './scale';
import { useWidth } from './useWidth';
import styles from './charts.module.css';

export interface BarDatum {
  label: string;
  value: number;
  /** Projected rather than recorded: drawn lighter and hatched. */
  projected?: boolean;
}

/**
 * Bars on one axis, zero-based, with a hover tooltip per bar.
 *
 * Blue for values, red only for a negative value — colour is never decoration.
 * Labels thin themselves out when bars get narrow, so a 30-day range stays
 * legible on a phone.
 */
export function BarChart({
  data,
  height = 240,
  ariaLabel,
  tooltip,
}: {
  data: readonly BarDatum[];
  height?: number;
  ariaLabel: string;
  tooltip: (d: BarDatum, index: number) => ReactNode;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);

  const left = 56;
  const right = 8;
  const top = 10;
  const bottom = 26;
  const plotW = Math.max(40, width - left - right);
  const plotH = height - top - bottom;

  const { min, max, ticks } = niceDomain(data.map((d) => d.value));
  const y = (v: number) => top + plotH * (1 - (v - min) / (max - min));
  const band = plotW / Math.max(1, data.length);
  const barW = Math.max(3, Math.min(36, band * 0.62));
  const every = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotW / 56))));
  const zero = y(0);

  const active = hover === null ? null : data[hover];

  return (
    <div ref={ref} className={styles.chart} style={{ height }}>
      <svg width={width} height={height} role="img" aria-label={ariaLabel}>
        <defs>
          <pattern id="sb-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="var(--sb-accent-tint)" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--sb-chart-2)" strokeWidth="2" />
          </pattern>
        </defs>

        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={left}
              x2={left + plotW}
              y1={y(t)}
              y2={y(t)}
              stroke={t === 0 ? 'var(--sb-hairline-strong)' : 'var(--sb-hairline-soft)'}
            />
            <text x={left - 8} y={y(t)} dy="0.32em" textAnchor="end" className={styles.axis}>
              {axisLabel(t)}
            </text>
          </g>
        ))}

        {data.map((d, i) => {
          const cx = left + band * i + band / 2;
          const yv = y(d.value);
          const h = Math.abs(zero - yv);
          const negative = d.value < 0;
          return (
            <g key={`${d.label}-${i}`}>
              {d.value !== 0 ? (
                <rect
                  x={cx - barW / 2}
                  y={negative ? zero : yv}
                  width={barW}
                  height={Math.max(1, h)}
                  rx={Math.min(3, barW / 3)}
                  fill={
                    d.projected
                      ? 'url(#sb-hatch)'
                      : negative
                        ? 'var(--sb-critical)'
                        : 'var(--sb-accent)'
                  }
                  opacity={hover === null || hover === i ? 1 : 0.45}
                />
              ) : null}
              {i % every === 0 ? (
                <text x={cx} y={height - 8} textAnchor="middle" className={styles.axis}>
                  {d.label}
                </text>
              ) : null}
              {/* The hit target is the whole column, wider than the bar. */}
              <rect
                x={left + band * i}
                y={top}
                width={band}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
              />
            </g>
          );
        })}
      </svg>

      {active && hover !== null ? (
        <div
          className={styles.tooltip}
          style={
            // Beside the bar, not over it: on whichever side has room.
            left + band * hover + band / 2 < width - 200
              ? { left: left + band * hover + band / 2 + barW / 2 + 10, top: 4 }
              : { left: left + band * hover + band / 2 - barW / 2 - 10, top: 4, transform: 'translateX(-100%)' }
          }
          role="status"
        >
          <div className={styles.tooltipTitle}>{active.label}</div>
          {tooltip(active, hover)}
        </div>
      ) : null}
    </div>
  );
}
