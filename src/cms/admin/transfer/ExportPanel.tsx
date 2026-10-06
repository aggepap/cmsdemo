'use client';

import { useMemo, useReducer, useState } from 'react';

import { cmsApi, type ListResponse } from '../api-client';
import { apiErrorText } from '../api-error-text';
import { Button, buttonVariants, Checkbox } from '../ui';
import { Icon } from '../ui/Icon';
import { ActionBar } from './ActionBar';
import { GroupPicker } from './GroupPicker';
import { ItemPicker, type PickerPage } from './ItemPicker';
import { PiiConsent } from './PiiConsent';
import { Progress } from './Progress';
import { TransferCard } from './TransferCard';
import { WizardSteps } from './WizardSteps';
import type { CatalogItem, ExportPreview, ExportProgress, GroupOption } from './types';
import {
  describeSelection,
  emptySelection,
  selectionReducer,
  selectionSize,
  toSelectionPayload,
} from './wizard-state';

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Step = 'select' | 'review' | 'building' | 'done';

const STEPS = ['Choose', 'Review', 'Build', 'Download'];
const STEP_INDEX: Record<Step, number> = { select: 0, review: 1, building: 2, done: 3 };

const toPage = (res: ListResponse<CatalogItem>): PickerPage => ({
  items: res.items,
  total: res.total,
  pageCount: res.pageCount,
});

/**
 * Export: choose → review what comes along → build → download.
 *
 * The package is built on the server over several short requests (there is no
 * job queue); this screen drives them and shows how far it has got.
 */
export function ExportPanel({ groups }: { groups: GroupOption[] }) {
  const [step, setStep] = useState<Step>('select');
  const [state, dispatch] = useReducer(selectionReducer, undefined, emptySelection);
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [piiOk, setPiiOk] = useState(false);
  const [withHashes, setWithHashes] = useState(false);
  const payload = (s = state) => ({
    ...toSelectionPayload(s),
    options: { acknowledgePii: piiOk, includePasswordHashes: withHashes },
  });
  const hasAccounts = ['users', 'customers'].some(
    (g) => (state.groups[g]?.mode ?? 'none') !== 'none'
  );

  const size = selectionSize(state);
  const labelOf = (key: string | null) => groups.find((g) => g.key === key)?.label ?? key ?? '';

  // One stable loader per group: the picker refetches whenever its loader changes.
  const loaders = useMemo(
    () =>
      new Map(
        groups.map((g) => [
          g.key,
          (q: string, page: number) =>
            cmsApi.transfer.catalog<CatalogItem>(g.key, q, page).then(toPage),
        ])
      ),
    [groups]
  );

  async function review(nextState = state) {
    setBusy(true);
    setError(null);
    try {
      const res = await cmsApi.transfer.exportPreview<ExportPreview>(payload(nextState));
      setPreview(res.data);
      setStep('review');
    } catch (err) {
      setError(apiErrorText(err, 'Could not work out what the export contains.'));
    } finally {
      setBusy(false);
    }
  }

  async function toggleDependency(key: string) {
    const next = selectionReducer(state, { type: 'optOut', key });
    dispatch({ type: 'optOut', key });
    await review(next);
  }

  async function build() {
    setBusy(true);
    setError(null);
    try {
      let res = (await cmsApi.transfer.exportStart<ExportProgress>(payload())).data;
      setProgress(res);
      setStep('building');
      while (res.phase === 'building') {
        const before = res.done;
        res = (await cmsApi.transfer.exportStep<ExportProgress>(res.id)).data;
        setProgress(res);
        // No progress means another request holds the job: wait instead of spinning.
        if (res.done === before) await pause(1000);
      }
      if (res.phase === 'failed') throw new Error(res.error ?? 'The export failed.');
      setStep('done');
    } catch (err) {
      setError(apiErrorText(err, 'The export failed.'));
      setStep('review');
    } finally {
      setBusy(false);
    }
  }

  function restart() {
    dispatch({ type: 'reset' });
    setPreview(null);
    setProgress(null);
    setStep('select');
  }

  return (
    <div className="flex flex-col gap-4">
      <WizardSteps label="Export steps" steps={STEPS} current={STEP_INDEX[step]} />
      {error ? (
        <p
          role="alert"
          className="rounded-sm border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        >
          {error}
        </p>
      ) : null}

      {step === 'select' ? (
        <>
          <p className="text-sm text-neutral-700">
            Choose what to put in the package. Whatever your choice depends on — a product’s
            categories, its images, the size chart — is added for you on the next screen.
          </p>
          <GroupPicker
            groups={groups}
            state={state}
            dispatch={dispatch}
            renderItems={(group) => (
              <ItemPicker
                label={group.label}
                load={loaders.get(group.key) as (q: string, page: number) => Promise<PickerPage>}
                selected={state.groups[group.key]?.keys ?? []}
                onToggle={(key) => dispatch({ type: 'toggle', group: group.key, key })}
              />
            )}
          />
          <ActionBar summary={describeSelection(size)}>
            <Button
              disabled={busy || (size.wholeGroups === 0 && size.items === 0)}
              onClick={() => review()}
            >
              {busy ? 'Checking…' : 'Review export'}
            </Button>
          </ActionBar>
        </>
      ) : null}

      {step === 'review' && preview ? (
        <>
          <TransferCard
            title="What goes in the package"
            right={
              <span role="status" className="tabular-nums">
                {preview.total} {preview.total === 1 ? 'item' : 'items'} in all
              </span>
            }
          >
            <dl className="grid max-w-xl grid-cols-[1fr_auto] gap-x-6 text-sm">
              {Object.entries(preview.counts).map(([g, n]) => (
                <div key={g} className="col-span-2 grid grid-cols-subgrid border-b border-neutral-100 py-1.5 last:border-0">
                  <dt className="text-neutral-700">{labelOf(g)}</dt>
                  <dd className="text-right font-medium text-neutral-900 tabular-nums">{n}</dd>
                </div>
              ))}
            </dl>
          </TransferCard>
          {preview.required.length > 0 ? (
            <TransferCard
              title={`Added because your selection needs them (${preview.required.length})`}
            >
              <p className="text-xs text-neutral-600">
                Untick one to leave it out. On import, links to it are matched to the same item on
                the other site, or removed if there is none.
              </p>
              <ul className="max-h-80 overflow-y-auto">
                {preview.required.map((r) => (
                  <li key={r.key}>
                    <Checkbox
                      label={r.label}
                      hint={labelOf(r.group)}
                      checked={!state.optOut.includes(r.key)}
                      disabled={busy}
                      onChange={() => toggleDependency(r.key)}
                    />
                  </li>
                ))}
              </ul>
            </TransferCard>
          ) : null}
          {state.optOut.length > 0 || preview.external.length > 0 ? (
            <section aria-labelledby="export-external" className="text-sm">
              <h3 id="export-external" className="font-medium text-neutral-900">
                Referenced but left out ({preview.external.length})
              </h3>
              <ul className="mt-1 max-h-40 list-disc overflow-y-auto pl-5 text-neutral-700">
                {preview.external.map((r) => (
                  <li key={r.key}>
                    {r.label}
                    {state.optOut.includes(r.key) ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-2"
                        onClick={() => toggleDependency(r.key)}
                      >
                        Include it
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {preview.pii ? (
            <PiiConsent message={preview.pii} checked={piiOk} onChange={setPiiOk} />
          ) : null}
          {hasAccounts ? (
            <Checkbox
              label="Include password hashes"
              hint="Needs the “Move admin accounts” permission. Without them, imported accounts must set a new password."
              checked={withHashes}
              onChange={(e) => setWithHashes(e.target.checked)}
            />
          ) : null}
          <ActionBar summary={`${preview.total} ${preview.total === 1 ? 'item' : 'items'} ready to package`}>
            <Button variant="secondary" disabled={busy} onClick={() => setStep('select')}>
              Back
            </Button>
            <Button
              disabled={busy || preview.total === 0 || (Boolean(preview.pii) && !piiOk)}
              onClick={build}
            >
              {busy ? 'Starting…' : 'Build the package'}
            </Button>
          </ActionBar>
        </>
      ) : null}

      {step === 'building' && progress ? (
        <Progress label="Building the package" done={progress.done} total={progress.total} />
      ) : null}

      {step === 'done' && progress ? (
        <div className="flex flex-col gap-3 rounded-sm border border-neutral-200 bg-white p-4">
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700"
            >
              <Icon name="check" size={16} />
            </span>
            <div role="status">
              <p className="text-sm font-semibold text-neutral-900">The package is ready</p>
              <p className="text-sm text-neutral-600">
                It holds {progress.total} {progress.total === 1 ? 'item' : 'items'} and is kept on
                the server for a day, then removed.
              </p>
            </div>
          </div>
          {progress.warnings?.length ? (
            <ul className="list-disc pl-5 text-sm text-amber-900">
              {progress.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
          <div className="flex gap-2">
            <a
              href={`/api/cms/transfer/exports/${progress.id}/download`}
              className={buttonVariants()}
            >
              <Icon name="upload" size={16} className="rotate-180" />
              Download the package
            </a>
            <Button variant="secondary" onClick={restart}>
              Start another export
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
