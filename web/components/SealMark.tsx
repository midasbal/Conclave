// The mark: an arched double door, shut, with a ribbon stretched across both leaves and a wax seal pressed over the seam.
// That is how a chamber was closed on the record: the leaves cannot part without breaking what lies across them.
export function SealMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 40 44" width="36" height="40" aria-hidden="true" focusable="false">
      {/* the two leaves, meeting at the seam */}
      <path d="M3 43V19C3 9.6 10 2.6 19.2 2V43Z" fill="var(--ink)" />
      <path d="M37 43V19C37 9.6 30 2.6 20.8 2V43Z" fill="var(--ink)" />
      {/* one sunk panel in each leaf, so that they read as doors */}
      <path d="M7.5 20.5v-1.2c.3-4.6 3.2-8.3 7.2-9.8v11ZM32.5 20.5v-1.2c-.3-4.6-3.2-8.3-7.2-9.8v11Z" fill="none" stroke="var(--paper)" strokeWidth="1.1" />
      <path d="M7.5 35.5h7.2V39H7.5ZM25.3 35.5h7.2V39h-7.2Z" fill="none" stroke="var(--paper)" strokeWidth="1.1" />
      {/* the ribbon across both, and the seal over the seam */}
      <rect x="0.5" y="25" width="39" height="5.5" fill="var(--seal)" />
      <circle cx="20" cy="27.75" r="7.6" fill="var(--seal)" stroke="var(--paper)" strokeWidth="1.3" />
      <circle cx="20" cy="27.75" r="3.9" fill="none" stroke="var(--paper)" strokeWidth="1.1" />
    </svg>
  );
}
