import type { SVGProps } from 'react';

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export const InputIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <rect x="2" y="4" width="20" height="13" rx="1.5" />
    <path d="M9 21h6M12 17v4M12 7v6m0 0 2.5-2.5M12 13 9.5 10.5" />
  </svg>
);

export const ProcessIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="10.5" r="3" />
    <path d="M12 3v2m0 11v2M4.7 6.2l1.7 1m11.2 6.6 1.7 1M4.7 14.8l1.7-1m11.2-6.6 1.7-1M9 21h6" />
  </svg>
);

export const OutputIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <path d="M6 9V3h12v6" />
    <rect x="3" y="9" width="18" height="7" rx="1.5" />
    <path d="M6 16h12v5H6z" />
  </svg>
);

export const DashboardIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <rect x="2" y="4" width="20" height="13" rx="1.5" />
    <path d="M6 13V9m4 4V7m4 6v-3m4 3V8M9 21h6M12 17v4" />
  </svg>
);

export const PeopleIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 19c0-3.2 2.7-5.2 6-5.2s6 2 6 5.2" />
    <circle cx="17.5" cy="9" r="2.6" />
    <path d="M16 14.2c3 .2 5 2.2 5 4.8" />
  </svg>
);

export const DataIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.2h7A1.5 1.5 0 0 1 19 9.7V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 18z" />
    <path d="M7 6V4.5A1.5 1.5 0 0 1 8.5 3h4l2 2.2h5A1.5 1.5 0 0 1 21 6.7V15" />
  </svg>
);

export const HomeIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5.5 9.5V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.5" />
    <path d="M9.5 21v-6h5v6" />
  </svg>
);

export const ProfileIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
  </svg>
);
