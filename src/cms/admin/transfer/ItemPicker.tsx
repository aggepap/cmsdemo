'use client';

import { useEffect, useState } from 'react';

import { apiErrorText } from '../api-error-text';
import { Button, Checkbox, Field, TextInput } from '../ui';

export interface PickerItem {
  key: string;
  label: string;
  meta?: string | null;
}

export interface PickerPage {
  items: PickerItem[];
  total: number;
  pageCount: number;
}

/**
 * A searchable, paged checklist. Loads one page at a time from the server —
 * a shop with thousands of products must not ship them all to the browser to
 * let someone tick three.
 */
export function ItemPicker({
  label,
  load,
  selected,
  onToggle,
}: {
  label: string;
  load: (q: string, page: number) => Promise<PickerPage>;
  selected: readonly string[];
  onToggle: (key: string) => void;
}) {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  // The last answer, tagged with the request it answers: "loading" is simply
  // "the answer on screen is for a different request", derived rather than stored.
  const request = `${query}\u0000${page}`;
  const [result, setResult] = useState<{
    request: string;
    data: PickerPage | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    let live = true;
    load(query, page)
      .then((data) => live && setResult({ request, data, error: null }))
      .catch(
        (err: unknown) =>
          live &&
          setResult((prev) => ({
            request,
            data: prev?.data ?? null,
            error: apiErrorText(err, 'Could not load the list.'),
          }))
      );
    return () => {
      live = false;
    };
  }, [load, query, page, request]);

  const loading = result?.request !== request;
  const data = result?.data ?? null;
  const error = result && !loading ? result.error : null;

  return (
    <div className="flex flex-col gap-2">
      <form
        className="flex items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setQuery(q.trim());
        }}
      >
        <Field label={`Search ${label.toLowerCase()}`} className="flex-1">
          <TextInput type="search" value={q} onChange={(e) => setQ(e.target.value)} />
        </Field>
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {loading && !data ? <p className="text-sm text-neutral-600">Loading…</p> : null}
      {data && data.items.length === 0 ? (
        <p className="text-sm text-neutral-600">Nothing matches.</p>
      ) : null}
      {data && data.items.length > 0 ? (
        <ul
          className="flex max-h-80 flex-col overflow-y-auto rounded-sm border border-neutral-200 px-3 py-1"
          aria-busy={loading}
        >
          {data.items.map((item) => (
            <li key={item.key}>
              <Checkbox
                label={item.label}
                hint={item.meta ?? undefined}
                checked={selected.includes(item.key)}
                onChange={() => onToggle(item.key)}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {data && data.pageCount > 1 ? (
        <nav aria-label={`${label} pages`} className="flex items-center gap-2 text-sm">
          <Button
            variant="secondary"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <span>
            Page {page} of {data.pageCount} · {data.total} in all
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={page >= data.pageCount}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </nav>
      ) : null}
    </div>
  );
}
