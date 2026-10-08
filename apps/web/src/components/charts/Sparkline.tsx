/**
 * A trend line with no axes, for a KPI card. One series, 1.75px stroke, the
 * last point marked so the eye lands on "now".
 */
export function Sparkline({
  values,
  width = 96,
  height = 30,
  label,
}: {
  values: readonly number[];
  width?: number;
  height?: number;
  label: string;
}) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 3;
  const x = (i: number) => pad + (i * (width - pad * 2)) / (values.length - 1);
  const y = (v: number) => pad + (height - pad * 2) * (1 - (v - min) / span);
  const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const last = values.length - 1;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <path d={d} fill="none" stroke="var(--sb-accent)" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last)} cy={y(values[last]!)} r={2.6} fill="var(--sb-accent)" />
    </svg>
  );
}
