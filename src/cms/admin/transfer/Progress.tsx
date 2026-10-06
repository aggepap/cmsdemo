/** A labelled determinate progress bar. */
export function Progress({ label, done, total }: { label: string; done: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-sm text-neutral-800">
        <span>{label}</span>
        <span>
          {done} / {total}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        className="h-2 overflow-hidden rounded-sm bg-neutral-200"
      >
        <div className="bg-warm-gold h-full transition-[width]" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
