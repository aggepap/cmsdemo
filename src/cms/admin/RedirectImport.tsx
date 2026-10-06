'use client';

import { useState } from 'react';

import { REDIRECT_CSV_MAX_BYTES, REDIRECT_CSV_MAX_ROWS } from '../core/seo/redirect-csv';
import type { ImportOutcome, ImportRowResult } from '../core/seo/redirect-import';
import { cmsApi } from './api-client';
import { apiErrorText } from './api-error-text';
import { Field } from './ui';

interface ImportResponse {
  committed: boolean;
  summary: Record<ImportOutcome, number>;
  rows: ImportRowResult[];
}

const input =
  'rounded-sm border border-neutral-300 bg-white px-2 py-1.5 text-sm focus:border-warm-gold focus:outline-none focus:ring-1 focus:ring-warm-gold';

/** What a row will do (preview) and what it did (after the import). */
const OUTCOME_LABEL: Record<ImportOutcome, { preview: string; done: string; tone: string }> = {
  create: { preview: 'will be created', done: 'created', tone: 'text-green-800' },
  pending: { preview: 'will be pending', done: 'pending', tone: 'text-amber-800' },
  complete: { preview: 'completes a pending mapping', done: 'completed', tone: 'text-green-800' },
  skip: { preview: 'skipped', done: 'skipped', tone: 'text-neutral-600' },
  error: { preview: 'error', done: 'error', tone: 'text-red-700' },
};

/**
 * Import redirects from CSV — the tool for a site migration, where a few hundred
 * old URLs arrive in a spreadsheet at once and typing them one by one is where
 * mistakes come from.
 *
 * Always two steps. "Preview" asks the server what every row would do and writes
 * nothing; only then can the import be committed, and the commit re-checks the
 * same text from scratch. Editing the text throws the preview away, so what is
 * committed is always what was previewed.
 */
export function RedirectImport({ onImported }: { onImported: () => Promise<void> }) {
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function change(text: string) {
    setCsv(text);
    setResult(null);
    setError(null);
  }

  async function readFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > REDIRECT_CSV_MAX_BYTES) {
      setError(`That file is too large — at most ${REDIRECT_CSV_MAX_BYTES / 1024} KB at a time.`);
      return;
    }
    try {
      change(await file.text());
    } catch {
      setError('That file could not be read.');
    }
  }

  async function send(commit: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await cmsApi.importRedirects<ImportResponse>({ csv, commit });
      setResult(res.data);
      if (commit) await onImported();
    } catch (err) {
      setError(apiErrorText(err, commit ? 'Could not import these redirects.' : 'Could not read this CSV.'));
    } finally {
      setBusy(false);
    }
  }

  const writes = result && !result.committed
    ? result.summary.create + result.summary.pending + result.summary.complete
    : 0;

  return (
    <details className="rounded-sm border border-neutral-200 bg-white">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-neutral-800">
        Import redirects from CSV
      </summary>
      <div className="flex flex-col gap-3 border-t border-neutral-200 p-3">
        <p className="text-xs text-neutral-600">
          One redirect per line: <code>source,target</code>, optionally followed by a status code and notes. A
          header row is optional. Leave the target empty to list an old address as <strong>pending</strong> — it
          redirects nobody until you choose where it goes. Existing redirects are never changed. Up to{' '}
          {REDIRECT_CSV_MAX_ROWS} rows at a time.
        </p>
        <Field label="CSV file" description="Or paste the rows below.">
          <input type="file" accept=".csv,.txt,text/csv,text/plain" className="text-sm" onChange={readFile} />
        </Field>
        <Field label="CSV">
          <textarea
            className={`${input} min-h-[8rem] font-mono text-xs`}
            placeholder={'source,target,status,notes\n/product/blue-shirt/,/shop/blue-shirt,301,\n/product/old-thing/,,,'}
            value={csv}
            onChange={(e) => change(e.target.value)}
          />
        </Field>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || !csv.trim()}
            onClick={() => void send(false)}
            className="rounded-sm border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-800 hover:bg-neutral-50 disabled:opacity-50"
          >
            Preview
          </button>
          {result && !result.committed ? (
            <button
              type="button"
              disabled={busy || writes === 0}
              onClick={() => void send(true)}
              className="rounded-sm bg-warm-gold px-3 py-1.5 text-sm font-medium text-midnight-navy hover:bg-warm-gold-dark disabled:opacity-50"
            >
              Import {writes} {writes === 1 ? 'row' : 'rows'}
            </button>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        ) : null}
        {result ? <ImportResult result={result} /> : null}
      </div>
    </details>
  );
}

function ImportResult({ result }: { result: ImportResponse }) {
  const { summary, committed } = result;
  const parts = (Object.keys(OUTCOME_LABEL) as ImportOutcome[])
    .filter((k) => summary[k] > 0)
    .map((k) => `${summary[k]} ${committed ? OUTCOME_LABEL[k].done : OUTCOME_LABEL[k].preview}`);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-neutral-800" aria-live="polite">
        {committed ? 'Imported: ' : 'Preview — nothing saved yet: '}
        {parts.join(', ') || 'no rows'}.
      </p>
      <div
        tabIndex={0}
        role="group"
        aria-label="Import results, scrollable"
        className="max-h-96 min-w-0 overflow-auto rounded-sm border border-neutral-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-warm-gold"
      >
        <table className="w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase text-neutral-600">
            <tr>
              <th className="px-3 py-2">Line</th>
              <th className="px-3 py-2">Source → Target</th>
              <th className="px-3 py-2">Code</th>
              <th className="px-3 py-2">Result</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100">
            {result.rows.map((r) => (
              <tr key={r.line}>
                <td className="px-3 py-2 text-xs text-neutral-600">{r.line}</td>
                <td className="px-3 py-2 font-mono text-xs">
                  {r.source || '—'} <span className="text-neutral-600">→</span> {r.target || '(pending)'}
                </td>
                <td className="px-3 py-2 text-neutral-600">{r.statusCode}</td>
                <td className={`px-3 py-2 text-xs ${OUTCOME_LABEL[r.outcome].tone}`}>
                  {committed ? OUTCOME_LABEL[r.outcome].done : OUTCOME_LABEL[r.outcome].preview}
                  {r.message ? <span className="block text-neutral-600">{r.message}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
