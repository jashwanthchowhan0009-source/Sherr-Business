'use client';

import { BarChart } from '@/components/charts/BarChart';
import chart from '@/components/charts/charts.module.css';
import { formatCompact, formatRupees, paise } from '@/lib/money';
import type { CashMonth } from '@/lib/dashboard/model';

const asPaise = (n: number) => paise(BigInt(Math.round(n)));

/** Net cash by month: six recorded, three projected from what is due. */
export function CashOutlookChart({ months }: { months: CashMonth[] }) {
  return (
    <>
      <BarChart
        height={200}
        data={months.map((m) => ({ label: m.label, value: m.inPaise - m.outPaise, projected: m.forecast }))}
        ariaLabel="Net cash flow by month, with three projected months"
        tooltip={(_, i) => {
          const m = months[i]!;
          return (
            <>
              <div className={chart.tipRow}><span>Money in</span><span>{formatCompact(asPaise(m.inPaise))}</span></div>
              <div className={chart.tipRow}><span>Money out</span><span>{formatCompact(asPaise(m.outPaise))}</span></div>
              <div className={chart.tipRow}>
                <span>{m.forecast ? 'Projected balance' : 'Balance'}</span>
                <b>{formatRupees(asPaise(m.balancePaise))}</b>
              </div>
            </>
          );
        }}
      />
      <div className={chart.legend}>
        <span><span className={chart.legendSwatch} style={{ background: 'var(--sb-accent)' }} />Recorded</span>
        <span>
          <span className={chart.legendSwatch} style={{ background: 'var(--sb-accent-tint)', border: '1.5px solid var(--sb-chart-2)' }} />
          Due from open invoices and bills
        </span>
      </div>
    </>
  );
}
