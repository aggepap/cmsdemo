'use client';

import {
  WEEKDAYS,
  type OpeningHours,
  type StoreLocation,
  type Weekday,
} from '../core/brand/policy';
import { MediaPicker } from './fields/MediaPicker';
import { Button, Checkbox, Field, TextInput } from './ui';

/**
 * The opening-hours and store-location editors of Settings → Branding.
 *
 * Both feed the site's structured data (a local business's hours, its other
 * shops as departments) and are exposed on the brand for pages that list them.
 * The rules — 24-hour times, a season that ends after it starts, unique location
 * ids — are enforced on save by the identity schema; these screens only shape
 * the input.
 */

const DAY_NAMES: Record<Weekday, string> = {
  Mo: 'Monday',
  Tu: 'Tuesday',
  We: 'Wednesday',
  Th: 'Thursday',
  Fr: 'Friday',
  Sa: 'Saturday',
  Su: 'Sunday',
};

const NEW_HOURS: OpeningHours = {
  days: ['Mo', 'Tu', 'We', 'Th', 'Fr'],
  opens: '09:00',
  closes: '17:00',
  validFrom: '',
  validThrough: '',
};

/** A short random id, generated once: it names the location in structured data. */
const newLocationId = () => Math.random().toString(36).slice(2, 10) || 'location';

const replaceAt = <T,>(list: readonly T[], i: number, value: T): T[] =>
  list.map((v, j) => (j === i ? value : v));

const move = <T,>(list: readonly T[], from: number, to: number): T[] => {
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
};

export function OpeningHoursEditor({
  value,
  onChange,
}: {
  value: readonly OpeningHours[];
  onChange: (next: OpeningHours[]) => void;
}) {
  const setRow = (i: number, patch: Partial<OpeningHours>) =>
    onChange(replaceAt(value, i, { ...value[i], ...patch }));
  const toggleDay = (i: number, day: Weekday, on: boolean) => {
    const days = on ? [...value[i].days, day] : value[i].days.filter((d) => d !== day);
    setRow(i, { days: WEEKDAYS.filter((d) => days.includes(d)) });
  };

  return (
    <div className="flex flex-col gap-3">
      {value.map((row, i) => (
        <fieldset key={i} className="flex flex-col gap-3 rounded-sm border border-neutral-200 p-3">
          <legend className="px-1 text-sm font-medium text-neutral-700">Hours {i + 1}</legend>
          <div className="flex flex-wrap gap-x-4">
            {WEEKDAYS.map((day) => (
              <Checkbox
                key={day}
                label={DAY_NAMES[day]}
                checked={row.days.includes(day)}
                onChange={(e) => toggleDay(i, day, e.target.checked)}
              />
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
            <Field label="Opens">
              <TextInput
                type="time"
                value={row.opens}
                onChange={(e) => setRow(i, { opens: e.target.value })}
              />
            </Field>
            <Field label="Closes" description="Earlier than opening means after midnight.">
              <TextInput
                type="time"
                value={row.closes}
                onChange={(e) => setRow(i, { closes: e.target.value })}
              />
            </Field>
            <Field label="Valid from" description="Optional, for seasonal hours.">
              <TextInput
                type="date"
                value={row.validFrom}
                onChange={(e) => setRow(i, { validFrom: e.target.value })}
              />
            </Field>
            <Field label="Valid through" description="Optional, the last day.">
              <TextInput
                type="date"
                value={row.validThrough}
                onChange={(e) => setRow(i, { validThrough: e.target.value })}
              />
            </Field>
          </div>
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              Remove hours
            </Button>
          </div>
        </fieldset>
      ))}
      <div>
        <Button variant="secondary" size="sm" onClick={() => onChange([...value, NEW_HOURS])}>
          Add opening hours
        </Button>
      </div>
    </div>
  );
}

const ADDRESS_FIELDS: { key: keyof StoreLocation['address']; label: string }[] = [
  { key: 'street', label: 'Street' },
  { key: 'city', label: 'City' },
  { key: 'postcode', label: 'Postcode' },
  { key: 'country', label: 'Country' },
];

export function LocationsEditor({
  value,
  onChange,
}: {
  value: readonly StoreLocation[];
  onChange: (next: StoreLocation[]) => void;
}) {
  const setLoc = (i: number, patch: Partial<StoreLocation>) =>
    onChange(replaceAt(value, i, { ...value[i], ...patch }));

  const add = () =>
    onChange([
      ...value,
      {
        id: newLocationId(),
        name: '',
        address: { street: '', city: '', postcode: '', country: '' },
        phone: '',
        openingHours: [],
        mapUrl: '',
        tourUrl: '',
        imageId: null,
      },
    ]);

  return (
    <div className="flex flex-col gap-4">
      {value.length === 0 ? (
        <p className="text-sm text-neutral-600">
          No other locations. Add the shops or offices beyond the main address, each with its own
          hours.
        </p>
      ) : null}
      {value.map((loc, i) => (
        <fieldset
          key={loc.id}
          className="flex flex-col gap-4 rounded-sm border border-neutral-200 p-4"
        >
          <legend className="px-1 text-sm font-semibold text-neutral-700">
            {loc.name || `Location ${i + 1}`}
          </legend>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Location name" required>
              <TextInput
                value={loc.name}
                maxLength={120}
                onChange={(e) => setLoc(i, { name: e.target.value })}
              />
            </Field>
            <Field label="Location phone">
              <TextInput
                type="tel"
                value={loc.phone}
                maxLength={40}
                onChange={(e) => setLoc(i, { phone: e.target.value })}
              />
            </Field>
            {ADDRESS_FIELDS.map((f) => (
              <Field key={f.key} label={f.label}>
                <TextInput
                  value={loc.address[f.key]}
                  onChange={(e) =>
                    setLoc(i, { address: { ...loc.address, [f.key]: e.target.value } })
                  }
                />
              </Field>
            ))}
            <Field
              label="Map link"
              description="A Google Maps or Apple Maps link to this location."
            >
              <TextInput
                type="url"
                placeholder="https://"
                value={loc.mapUrl}
                onChange={(e) => setLoc(i, { mapUrl: e.target.value })}
              />
            </Field>
            <Field
              label="3D tour link"
              description="Optional. A 360° or 3D tour, such as Matterport."
            >
              <TextInput
                type="url"
                placeholder="https://"
                value={loc.tourUrl}
                onChange={(e) => setLoc(i, { tourUrl: e.target.value })}
              />
            </Field>
          </div>
          <Field label="Location photo" composite>
            <MediaPicker
              value={loc.imageId ?? ''}
              onChange={(uuid) => setLoc(i, { imageId: uuid ?? null })}
            />
          </Field>
          <Field label="Location opening hours" composite>
            <OpeningHoursEditor
              value={loc.openingHours}
              onChange={(openingHours) => setLoc(i, { openingHours })}
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={i === 0}
              onClick={() => onChange(move(value, i, i - 1))}
            >
              Move up
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={i === value.length - 1}
              onClick={() => onChange(move(value, i, i + 1))}
            >
              Move down
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              Remove location
            </Button>
          </div>
        </fieldset>
      ))}
      <div>
        <Button variant="secondary" size="sm" onClick={add}>
          Add a location
        </Button>
      </div>
    </div>
  );
}
