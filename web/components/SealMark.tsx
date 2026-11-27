// Two closed door leaves, and one seal set across the seam: the way a chamber is shown to be shut. Opening it would have to break the seal.
export function SealMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 28 32" width="28" height="32" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="12" height="30" fill="var(--ink)" />
      <rect x="15" y="1" width="12" height="30" fill="var(--ink)" />
      <circle cx="14" cy="16" r="6.5" fill="var(--seal)" stroke="var(--paper)" strokeWidth="1.5" />
    </svg>
  );
}
