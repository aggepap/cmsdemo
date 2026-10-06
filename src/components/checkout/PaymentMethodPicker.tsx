'use client';

/**
 * How the customer pays, when the site takes more than one way.
 *
 * Shared by the shop checkout and a booking's pay page. A radio group, because
 * it is a single choice among a few — and because a radio group is what a
 * keyboard and a screen reader already know how to operate. With one method
 * there is nothing to choose, so nothing renders and the page reads as it did
 * before several methods existed.
 *
 * Labels come in translated: the server knows which methods are enabled, the
 * caller knows how to name them.
 */
export interface PaymentMethodOption {
  key: string;
  label: string;
  /** A short note beside the label — e.g. the surcharge this method adds. */
  hint?: string;
}

export function PaymentMethodPicker({
  legend,
  name,
  options,
  value,
  onChange,
}: {
  legend: string;
  /** Shared by every radio, so arrow keys move between them. */
  name: string;
  options: PaymentMethodOption[];
  value: string;
  onChange: (key: string) => void;
}) {
  if (options.length < 2) return null;

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="font-display text-midnight-navy mb-1 text-lg font-semibold">
        {legend}
      </legend>
      {options.map((option) => (
        <label
          key={option.key}
          className="border-border-soft flex cursor-pointer items-center gap-3 rounded-sm border p-3"
        >
          <input
            type="radio"
            name={name}
            value={option.key}
            className="accent-warm-gold-deep h-4 w-4"
            checked={value === option.key}
            onChange={() => onChange(option.key)}
          />
          <span className="font-body text-text-primary flex-1 text-sm font-medium">
            {option.label}
          </span>
          {option.hint ? (
            <span className="font-body text-text-muted text-sm">{option.hint}</span>
          ) : null}
        </label>
      ))}
    </fieldset>
  );
}
