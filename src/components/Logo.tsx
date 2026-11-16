export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs><linearGradient id="tbg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#818cf8" /><stop offset="1" stopColor="#5eead4" /></linearGradient></defs>
      <rect width="32" height="32" rx="9" fill="url(#tbg)" />
      <path d="M6 20c3-9 17-9 20 0" fill="none" stroke="#06121a" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M11 22v-5M16 22v-8M21 22v-5" stroke="#06121a" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}
