import type { SVGProps } from 'react';

/** One stroke family, 24px grid, 1.6 stroke — quiet enough for a dense rail. */
const base = {
  viewBox: '0 0 24 24',
  width: 18,
  height: 18,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

type P = SVGProps<SVGSVGElement>;

export const DashboardIcon = (p: P) => (
  <svg {...base} {...p}>
    <rect x="3" y="3" width="7.5" height="9" rx="1.5" />
    <rect x="13.5" y="3" width="7.5" height="5" rx="1.5" />
    <rect x="13.5" y="11" width="7.5" height="10" rx="1.5" />
    <rect x="3" y="15" width="7.5" height="6" rx="1.5" />
  </svg>
);

export const SalesIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
    <path d="M9 8h6M9 12h6" />
  </svg>
);

export const PurchasesIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M3 4h2.2l2.3 11h10.8L20.5 7H6.4" />
    <circle cx="9.5" cy="19" r="1.4" />
    <circle cx="17" cy="19" r="1.4" />
  </svg>
);

export const AccountingIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z" />
    <path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v3H6.5" />
    <path d="M9 8h7M9 11.5h5" />
  </svg>
);

export const FinanceIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M3 20h18" />
    <path d="m4 15 5-5 4 3 7-7" />
    <path d="M15 6h5v5" />
  </svg>
);

export const InventoryIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="m12 3 8.5 4.5v9L12 21l-8.5-4.5v-9z" />
    <path d="m3.5 7.5 8.5 4.5 8.5-4.5M12 12v9" />
  </svg>
);

export const TaxIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 3 4.5 6v5.5c0 4.4 3.1 8.1 7.5 9.5 4.4-1.4 7.5-5.1 7.5-9.5V6z" />
    <path d="m9.5 14.5 5-5" />
    <circle cx="9.7" cy="9.7" r=".9" />
    <circle cx="14.3" cy="14.3" r=".9" />
  </svg>
);

export const EmployeesIcon = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3 20c.7-3.4 3.2-5.3 6-5.3s5.3 1.9 6 5.3" />
    <path d="M15.5 4.9a3.2 3.2 0 0 1 0 6.2M17.5 14.9c1.8.6 3 2.4 3.5 5.1" />
  </svg>
);

export const ReportsIcon = (p: P) => (
  <svg {...base} {...p}>
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <path d="M8.5 16v-3M12 16V9M15.5 16v-5" />
  </svg>
);

export const DocumentsIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z" />
    <path d="M14 3v5h5M8.5 13h7M8.5 16.5h5" />
  </svg>
);

export const IntelligenceIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
    <path d="M12 8.5 13.2 11 16 12l-2.8 1-1.2 2.5L10.8 13 8 12l2.8-1z" />
  </svg>
);

export const SettingsIcon = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
  </svg>
);

export const SearchIcon = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </svg>
);

export const PlusIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const MenuIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);

export const CloseIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </svg>
);

export const ChevronIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="m9 6 6 6-6 6" />
  </svg>
);

export const AlertIcon = (p: P) => (
  <svg {...base} {...p}>
    <path d="M12 3.5 2.5 20h19z" />
    <path d="M12 10v4.5M12 17.3v.2" />
  </svg>
);

export const CheckIcon = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="m8 12.3 2.7 2.7L16.2 9.5" />
  </svg>
);

export const ClockIcon = (p: P) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3.2 2" />
  </svg>
);
