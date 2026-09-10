// Small inline line-icons (no icon library — the build stays self-contained).
// Each inherits color from `currentColor` and sizes with font-size / width.

type P = { size?: number; className?: string };
const base = (size: number, className?: string) => ({
  width: size, height: size, viewBox: "0 0 24 24", fill: "none",
  stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const, className,
});

export const CpuIcon = ({ size = 20, className }: P) => (
  <svg {...base(size, className)}>
    <rect x="7" y="7" width="10" height="10" rx="1.5" />
    <rect x="4.5" y="4.5" width="15" height="15" rx="2.5" />
    <path d="M9 1.5v3M15 1.5v3M9 19.5v3M15 19.5v3M1.5 9h3M1.5 15h3M19.5 9h3M19.5 15h3" />
  </svg>
);
export const RamIcon = ({ size = 20, className }: P) => (
  <svg {...base(size, className)}>
    <rect x="2" y="8" width="20" height="9" rx="1.5" />
    <path d="M6 17v2M10 17v2M14 17v2M18 17v2M6 11.5v2M9.5 11.5v2M13 11.5v2M16.5 11.5v2" />
  </svg>
);
export const DiskIcon = ({ size = 20, className }: P) => (
  <svg {...base(size, className)}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <circle cx="12" cy="12" r="3" />
    <path d="M12 4v3M17 7h.01" />
  </svg>
);
export const GatewayIcon = ({ size = 20, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" />
  </svg>
);
export const SendIcon = ({ size = 20, className }: P) => (
  <svg {...base(size, className)}>
    <path d="m22 2-7 20-4-9-9-4 20-7Z" />
  </svg>
);
export const LinkIcon = ({ size = 20, className }: P) => (
  <svg {...base(size, className)}>
    <path d="M9 12a3 3 0 0 0 4.5 2.6l3-1.7A3 3 0 0 0 14 8.4l-1 .5" />
    <path d="M15 12a3 3 0 0 0-4.5-2.6l-3 1.7A3 3 0 0 0 10 15.6l1-.5" />
  </svg>
);
