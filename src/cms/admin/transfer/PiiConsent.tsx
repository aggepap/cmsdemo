'use client';

import { Checkbox } from '../ui';

/**
 * The explicit yes a package with personal data needs, at export and at
 * import. The server refuses without it; this is where the person gives it.
 */
export function PiiConsent({
  message,
  checked,
  onChange,
}: {
  message: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="rounded-sm border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
      <p role="status">{message}</p>
      <Checkbox
        label="I am allowed to move this personal data, and the file will be kept safe and deleted when done"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </div>
  );
}
