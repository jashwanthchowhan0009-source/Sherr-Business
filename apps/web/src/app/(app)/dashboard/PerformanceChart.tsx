'use client';

import { useMemo, useState } from 'react';
import { BarChart } from '@/components/charts/BarChart';
import chart from '@/components/charts/charts.module.css';
import { formatCompact, formatRupees, paise } from '@/lib/money';
import {
  RANGES, SERIES, bucketsFor, valueOf, type DayPoint, type RangeKey, type SeriesKey,
} from '@/lib/dashboard/model';

const SERIES_LABELS: Record<SeriesKey, string> = {
  revenue: 'Revenue',
  expenses: 'Expenses',
  profit: 'Profit',
  cash: 'Cash flow',
};

const asPaise = (n: number) => paise(BigInt(Math.round(n)));

export function PerformanceChart({ points, today }: { points: DayPoint[]; today: string }) {
  const [series, setSeries] = useState<SeriesKey>('revenue');
  const [range, setRange] = useState<RangeKey>('6M');

  const buckets = useMemo(() => bucketsFor(range, points, today), [range, points, today]);
  const data = buckets.map((b) => ({ label: b.label, value: valueOf(b, series) }));
  const total = data.reduce((s, d) => s + d.value, 0);
  const empty = data.every((d) => d.value === 0);

  return (
    <>
      <div className={chart.controls}>
        <div className={chart.segmented} role="group" aria-label="Measure">
          {SERIES.map((s) => (
            <button
              key={s}
              type="button"
              className={chart.segment}
              aria-pressed={series === s}
              onClick={() => setSeries(s)}
            >
              {SERIES_LABELS[s]}
            </button>
          ))}
        </div>
        <div className={chart.segmented} role="group" aria-label="Period">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              className={chart.segment}
              aria-pressed={range === r}
              onClick={() => setRange(r)}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className={chart.total}>
        <b>{formatCompact(asPaise(total))}</b>
        {SERIES_LABELS[series].toLowerCase()} over {range === '1Y' ? 'the last year' : `the last ${range.replace('D', ' days').replace('M', ' months')}`}
      </div>

      {empty ? (
        <p className={chart.total} style={{ padding: '72px 0', textAlign: 'center' }}>
          Nothing posted in this period.
        </p>
      ) : (
        <BarChart
          data={data}
          ariaLabel={`${SERIES_LABELS[series]} by period`}
          tooltip={(d, i) => {
            const b = buckets[i]!;
            return (
              <>
                <div className={chart.tipRow}>
                  <span>{SERIES_LABELS[series]}</span>
                  <b>{formatRupees(asPaise(d.value))}</b>
                </div>
                {series === 'cash' ? (
                  <>
                    <div className={chart.tipRow}><span>In</span><span>{formatCompact(asPaise(b.cashIn))}</span></div>
                    <div className={chart.tipRow}><span>Out</span><span>{formatCompact(asPaise(b.cashOut))}</span></div>
                  </>
                ) : null}
              </>
            );
          }}
        />
      )}
    </>
  );
}
