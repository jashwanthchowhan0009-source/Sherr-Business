/** Axis maths for the dashboard charts. Display only — never used for money. */

/** A "nice" tick step (1, 2, 2.5 or 5 × 10ⁿ) giving roughly `count` ticks. */
export function niceStep(span: number, count = 4): number {
  if (span <= 0) return 1;
  const raw = span / count;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / pow;
  const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10;
  return nice * pow;
}

/** Domain and ticks covering `values`, always including zero. */
export function niceDomain(values: readonly number[], count = 4): { min: number; max: number; ticks: number[] } {
  let lo = Math.min(0, ...values);
  let hi = Math.max(0, ...values);
  if (lo === hi) hi = lo + 1;
  const step = niceStep(hi - lo, count);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Math.round(t / step) * step);
  return { min: lo, max: hi, ticks };
}

/** Compact rupee label for an axis tick, from paise. */
export function axisLabel(paise: number): string {
  const r = paise / 100;
  const abs = Math.abs(r);
  const sign = r < 0 ? '−' : '';
  if (abs >= 1e7) return `${sign}₹${trim(abs / 1e7)}Cr`;
  if (abs >= 1e5) return `${sign}₹${trim(abs / 1e5)}L`;
  if (abs >= 1e3) return `${sign}₹${trim(abs / 1e3)}K`;
  return `${sign}₹${Math.round(abs)}`;
}

function trim(n: number): string {
  return n >= 100 ? Math.round(n).toString() : (Math.round(n * 10) / 10).toString();
}
