'use client';

import { useEffect, useMemo, useReducer, useState } from 'react';

import { MODULE_LABELS, moduleLabel, moduleSettingKey } from '../../core/settings/schema';
import { groupDef, isGroupKey } from '../../core/transfer/groups';
import { cmsApi, type ListResponse } from '../api-client';
import { apiErrorText } from '../api-error-text';
import { Badge, Button, Checkbox, Field, Select } from '../ui';
import { cn } from '../ui/cn';
import { Icon } from '../ui/Icon';
import { ActionBar } from './ActionBar';
import { useConfirm } from '../ui/ConfirmDialog';
import { uploadInChunks } from './chunked-upload';
import { ConflictTable } from './ConflictTable';
import { DryRunSummary } from './DryRunSummary';
import { GroupPicker } from './GroupPicker';
import { ImportReportView } from './ImportReportView';
import { ItemPicker, type PickerPage } from './ItemPicker';
import { ModuleNotice } from './ModuleNotice';
import { ACTION_LABELS } from './labels';
import { PiiConsent } from './PiiConsent';
import { Progress } from './Progress';
import { TransferCard } from './TransferCard';
import { WizardSteps } from './WizardSteps';
import type {
  DryRun,
  GroupOption,
  ImportItem,
  ImportProgress,
  ImportSummary,
  ReportRow,
  TransferAction,
  TransferJob,
} from './types';
import {
  describeSelection,
  emptySelection,
  selectionReducer,
  selectionSize,
  toSelectionPayload,
} from './wizard-state';

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Step = 'upload' | 'uploading' | 'choose' | 'dryrun' | 'running' | 'report';

const STEPS = ['Upload', 'Choose', 'Preview', 'Import', 'Report'];
const STEP_INDEX: Record<Step, number> = {
  upload: 0,
  uploading: 0,
  choose: 1,
  dryrun: 2,
  running: 3,
  report: 4,
};

const humanize = (key: string) => {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const fileSize = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const MB = 1024 * 1024;
const toPage = (res: ListResponse<ImportItem>): PickerPage => ({
  items: res.items.map((i) => ({
    key: i.key,
    label: i.label,
    meta: i.invalid ?? i.match?.label ?? null,
  })),
  total: res.total,
  pageCount: res.pageCount,
});

/** The conflicting items of one group, a page at a time. */
function GroupConflicts({
  id,
  group,
  allowed,
  defaultAction,
  overrides,
  onOverride,
}: {
  id: string;
  group: string;
  allowed: TransferAction[];
  defaultAction: TransferAction;
  overrides: Record<string, TransferAction>;
  onOverride: (key: string, action: TransferAction | null) => void;
}) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResponse<ImportItem> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    cmsApi.transfer
      .importItems<ImportItem>(id, group, 'conflicts', '', page)
      .then((res) => live && setData(res))
      .catch(
        (err: unknown) => live && setError(apiErrorText(err, 'Could not load the conflicts.'))
      );
    return () => {
      live = false;
    };
  }, [id, group, page]);
  if (error)
    return (
      <p role="alert" className="text-sm text-red-700">
        {error}
      </p>
    );
  if (!data) return <p className="text-sm text-neutral-600">Loading…</p>;
  return (
    <div className="flex flex-col gap-2">
      <ConflictTable
        items={data.items}
        allowed={allowed}
        defaultAction={defaultAction}
        overrides={overrides}
        onOverride={onOverride}
      />
      {data.pageCount > 1 ? (
        <nav aria-label="Conflict pages" className="flex items-center gap-2 text-sm">
          <Button
            variant="secondary"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Previous
          </Button>
          <span>
            Page {page} of {data.pageCount}
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

/**
 * Import: upload → see what is inside and what already exists here → choose,
 * item by item if needed → dry run → run → report.
 */
export function ImportPanel({
  siteGroups,
  targetLocales,
  canManageModules = false,
}: {
  siteGroups: GroupOption[];
  targetLocales: string[];
  /** May switch modules on (Settings → write); the settings API checks it again. */
  canManageModules?: boolean;
}) {
  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [id, setId] = useState<string | null>(null);
  const [sent, setSent] = useState(0);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [state, dispatch] = useReducer(selectionReducer, undefined, emptySelection);
  const [defaults, setDefaults] = useState<Record<string, TransferAction>>({});
  const [overrides, setOverrides] = useState<Record<string, TransferAction>>({});
  const [localeMap, setLocaleMap] = useState<Record<string, string | null>>({});
  const [keepStatus, setKeepStatus] = useState(true);
  const [copiesAsDrafts, setCopiesAsDrafts] = useState(true);
  const [piiOk, setPiiOk] = useState(false);
  const [withHashes, setWithHashes] = useState(false);
  const [dryRun, setDryRun] = useState<DryRun | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [report, setReport] = useState<ReportRow[] | null>(null);
  const [jobs, setJobs] = useState<TransferJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const { confirm, dialog } = useConfirm();

  useEffect(() => {
    cmsApi.transfer
      .jobs<TransferJob>()
      .then((res) => setJobs(res.data.filter((j) => j.kind === 'import')))
      .catch(() => undefined);
  }, []);

  const groups: GroupOption[] = useMemo(
    () =>
      (summary?.groups ?? []).map((g) => {
        const site = siteGroups.find((s) => s.key === g.group);
        return {
          key: g.group,
          // A collection this site lacks has no label here: show its key as words.
          label: site?.label ?? humanize(g.label),
          pii: g.pii,
          module: g.module ?? site?.module ?? null,
          moduleOff: g.moduleOff ?? false,
        };
      }),
    [summary, siteGroups]
  );
  const loaders = useMemo(
    () =>
      new Map(
        groups.map((g) => [
          g.key,
          (q: string, page: number) =>
            cmsApi.transfer.importItems<ImportItem>(id ?? '', g.key, 'all', q, page).then(toPage),
        ])
      ),
    [groups, id]
  );

  function fail(err: unknown, fallback: string) {
    setError(apiErrorText(err, fallback));
    setBusy(false);
  }

  async function analyze(jobId: string) {
    const res = await cmsApi.transfer.importComplete<ImportSummary>(jobId);
    setSummary(res.data);
    setLocaleMap(res.data.localeMap);
    setStep('choose');
  }

  /** Switch a module on for this site, then check the package against it again. */
  async function activate(module: string) {
    if (!id) return;
    const label = moduleLabel(module);
    const ok = await confirm({
      title: `Turn on ${label}?`,
      message: `${MODULE_LABELS[module]?.description ?? `This switches on the ${label} module for the whole site.`} It stays on after the import; you can switch it off again under Settings → Modules.`,
      confirmLabel: `Turn on ${label}`,
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await cmsApi.updateSiteSettings({ [moduleSettingKey(module)]: true });
      await analyze(id);
    } catch (err) {
      fail(err, `Could not turn on ${label}.`);
      return;
    }
    setBusy(false);
  }

  async function upload() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      let jobId = id;
      let from = 0;
      let chunkSize = 8 * MB;
      if (!jobId) {
        const created = (await cmsApi.transfer.importCreate(file.name, file.size)).data;
        jobId = created.id;
        chunkSize = created.chunkSize;
        setId(jobId);
      } else {
        from = (await cmsApi.transfer.importGet<{ offset: number }>(jobId)).data.offset;
      }
      setStep('uploading');
      await uploadInChunks({ file, id: jobId, chunkSize, from, onProgress: setSent });
      await analyze(jobId);
    } catch (err) {
      setStep('upload');
      fail(err, 'The upload failed.');
      return;
    }
    setBusy(false);
  }

  async function plan() {
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      const res = await cmsApi.transfer.importPlan<DryRun>(id, {
        decisions: { selection: toSelectionPayload(state), defaults, overrides },
        options: {
          localeMap,
          keepStatus,
          copiesAsDrafts,
          acknowledgePii: piiOk,
          importPasswordHashes: withHashes,
        },
      });
      setDryRun(res.data);
      setStep('dryrun');
    } catch (err) {
      fail(err, 'Could not prepare the import.');
      return;
    }
    setBusy(false);
  }

  async function run(jobId: string) {
    setBusy(true);
    setError(null);
    setStep('running');
    try {
      let res = (await cmsApi.transfer.importStep<ImportProgress>(jobId)).data;
      setProgress(res);
      while (res.phase === 'running' || res.phase === 'patching' || res.phase === 'ready') {
        const before = res.done;
        res = (await cmsApi.transfer.importStep<ImportProgress>(jobId)).data;
        setProgress(res);
        // No progress means another request holds the job: wait instead of spinning.
        if (res.done === before && res.phase !== 'done') await pause(1000);
      }
      await showReport(jobId);
    } catch (err) {
      fail(
        err,
        'The import stopped. Open it again from the list below to continue where it left off.'
      );
      return;
    }
    setBusy(false);
  }

  async function start() {
    if (!id || !dryRun) return;
    const destructive = dryRun.summary.overwrite + dryRun.summary.merge > 0;
    const ok = await confirm({
      title: 'Run this import?',
      message: destructive
        ? `${dryRun.summary.overwrite + dryRun.summary.merge} item(s) on this site will be changed. Content keeps its version history; settings do not.`
        : `${dryRun.total} item(s) will be processed.`,
      confirmLabel: 'Run the import',
      destructive,
    });
    if (ok) await run(id);
  }

  async function cancel() {
    if (!id) return;
    try {
      await cmsApi.transfer.importStep<ImportProgress>(id, true);
    } catch (err) {
      setError(apiErrorText(err, 'Could not cancel.'));
    }
  }

  async function showReport(jobId: string) {
    const res = await cmsApi.transfer.importReport<{ rows: ReportRow[] }>(jobId);
    setReport(res.data.rows);
    setStep('report');
  }

  async function open(job: TransferJob) {
    setError(null);
    setId(job.id);
    try {
      const res = await cmsApi.transfer.importGet<{
        info: { size?: number; filename?: string };
        offset: number;
        summary: ImportSummary | null;
        progress: ImportProgress | null;
      }>(job.id);
      const { summary: s, progress: p, offset, info } = res.data;
      if (p && (p.phase === 'done' || p.phase === 'cancelled'))
        return void (await showReport(job.id));
      if (p && p.phase !== 'ready') return void (await run(job.id));
      if (s) {
        setSummary(s);
        setLocaleMap(s.localeMap);
        return void setStep('choose');
      }
      if (typeof info.size === 'number' && offset >= info.size) return void (await analyze(job.id));
      setError(`Choose ${info.filename ?? 'the same file'} again to finish uploading it.`);
    } catch (err) {
      fail(err, 'Could not open that import.');
    }
  }

  async function discard(jobId: string) {
    try {
      await cmsApi.transfer.importDelete(jobId);
      setJobs((list) => list.filter((j) => j.id !== jobId));
      if (jobId === id) setId(null);
    } catch (err) {
      setError(apiErrorText(err, 'Could not delete it.'));
    }
  }

  const blockers = summary?.compatibility.blockers ?? [];
  const size = selectionSize(state);

  return (
    <div className="flex flex-col gap-4">
      {dialog}
      <WizardSteps label="Import steps" steps={STEPS} current={STEP_INDEX[step]} />
      {error ? (
        <p
          role="alert"
          className="rounded-sm border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        >
          {error}
        </p>
      ) : null}

      {step === 'upload' ? (
        <>
          <p className="rounded-sm border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            Take a backup of this site’s database before importing. Overwritten content can be
            restored from its version history, but overwritten settings and other records cannot.
          </p>
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const dropped = e.dataTransfer.files[0];
              if (dropped) setFile(dropped);
            }}
            className={cn(
              'flex cursor-pointer flex-col items-center gap-2 rounded-sm border-2 border-dashed bg-white px-6 py-10 text-center transition-colors',
              'has-[:focus-visible]:ring-warm-gold has-[:focus-visible]:ring-2',
              dragging ? 'border-neutral-900 bg-neutral-50' : 'border-neutral-300 hover:border-neutral-400'
            )}
          >
            <input
              type="file"
              accept=".zip,application/zip"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="sr-only"
            />
            <span
              aria-hidden
              className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-100 text-neutral-700"
            >
              <Icon name="upload" size={20} />
            </span>
            <span className="text-sm font-medium text-neutral-900">
              Upload a package exported from another site
            </span>
            {file ? (
              <span className="text-sm text-neutral-700">
                <span className="font-medium">{file.name}</span> · {fileSize(file.size)} ·{' '}
                <span className="underline underline-offset-2">choose another</span>
              </span>
            ) : (
              <span className="text-xs text-neutral-600">
                Drop the .zip here, or <span className="underline underline-offset-2">browse</span>{' '}
                — as downloaded from Export.
              </span>
            )}
          </label>
          <div>
            <Button disabled={!file || busy} onClick={upload}>
              {busy ? 'Uploading…' : 'Upload and check'}
            </Button>
          </div>
          {jobs.length > 0 ? (
            <section aria-labelledby="import-jobs" className="flex flex-col gap-2">
              <h3 id="import-jobs" className="text-sm font-medium text-neutral-900">
                Your recent imports
              </h3>
              <ul className="flex flex-col gap-1 text-sm">
                {jobs.map((job) => (
                  <li key={job.id} className="flex flex-wrap items-center gap-2">
                    <span>{job.info.filename ?? job.id}</span>
                    <span className="text-xs text-neutral-600">
                      {new Date(job.createdAt).toLocaleString()}
                    </span>
                    <Button variant="secondary" size="sm" onClick={() => open(job)}>
                      Open
                    </Button>
                    <Button variant="danger" size="sm" onClick={() => discard(job.id)}>
                      Delete
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}

      {step === 'uploading' && file ? (
        <div className="flex flex-col gap-2">
          <Progress
            label="Uploading (MB)"
            done={Math.round(sent / MB)}
            total={Math.max(1, Math.round(file.size / MB))}
          />
          {sent >= file.size ? (
            <p role="status" className="text-sm text-neutral-700">
              Checking the package and comparing it with this site…
            </p>
          ) : null}
        </div>
      ) : null}

      {step === 'choose' && summary && id ? (
        <>
          <TransferCard
            title={`From ${summary.source.siteName}`}
            right={summary.containsPii ? <Badge tone="amber">Contains personal data</Badge> : null}
          >
            <p className="text-sm text-neutral-700">
              {summary.source.origin || 'Unknown address'} · exported{' '}
              {new Date(summary.source.createdAt).toLocaleString()} · CMS{' '}
              {summary.source.cmsVersion}
            </p>
            {[...blockers, ...summary.compatibility.warnings].map((w) => (
              <p
                key={w}
                role={blockers.includes(w) ? 'alert' : undefined}
                className="rounded-sm bg-amber-50 px-3 py-2 text-sm text-amber-900"
              >
                {w}
              </p>
            ))}
          </TransferCard>

          <TransferCard title="Languages">
            <div className="flex flex-wrap gap-4">
              {summary.source.locales.map((from) => (
                <Field key={from} label={`Package “${from}” goes to`}>
                  <Select
                    value={localeMap[from] ?? ''}
                    onChange={(e) =>
                      setLocaleMap((m) => ({ ...m, [from]: e.target.value || null }))
                    }
                  >
                    <option value="">Leave out</option>
                    {targetLocales.map((to) => (
                      <option key={to} value={to}>
                        {to}
                      </option>
                    ))}
                  </Select>
                </Field>
              ))}
            </div>
          </TransferCard>

          <GroupPicker
            groups={groups}
            state={state}
            dispatch={dispatch}
            sectionNote={(section) =>
              section.off && section.module ? (
                <ModuleNotice
                  module={section.module}
                  count={section.groups.reduce(
                    (n, g) => n + (summary.groups.find((x) => x.group === g.key)?.total ?? 0),
                    0
                  )}
                  canActivate={canManageModules}
                  busy={busy}
                  onActivate={() => activate(section.module as string)}
                />
              ) : null
            }
            note={(g) => {
              const s = summary.groups.find((x) => x.group === g.key);
              if (!s) return null;
              return `${s.total} in the package${s.conflicts ? `, ${s.conflicts} already here` : ''}${s.invalid ? `, ${s.invalid} cannot be imported` : ''}.`;
            }}
            renderItems={(group) => (
              <ItemPicker
                label={group.label}
                load={loaders.get(group.key) as (q: string, page: number) => Promise<PickerPage>}
                selected={state.groups[group.key]?.keys ?? []}
                onToggle={(key) => dispatch({ type: 'toggle', group: group.key, key })}
              />
            )}
          />

          {groups
            .filter((g) => isGroupKey(g.key) && (state.groups[g.key]?.mode ?? 'none') !== 'none')
            .map((g) => {
              const s = summary.groups.find((x) => x.group === g.key);
              const def = isGroupKey(g.key) ? groupDef(g.key) : null;
              if (!s || !s.conflicts || !def || def.actions.length === 0) return null;
              const current = defaults[g.key] ?? def.defaultAction;
              return (
                <TransferCard
                  key={g.key}
                  headingId={`conf-${g.key}`}
                  title={`${g.label} that already exist here (${s.conflicts})`}
                >
                  <Field label="Unless chosen otherwise below" className="max-w-sm">
                    <Select
                      value={current}
                      onChange={(e) =>
                        setDefaults((d) => ({ ...d, [g.key]: e.target.value as TransferAction }))
                      }
                    >
                      {def.actions.map((a) => (
                        <option key={a} value={a}>
                          {ACTION_LABELS[a]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <GroupConflicts
                    id={id}
                    group={g.key}
                    allowed={def.actions}
                    defaultAction={current}
                    overrides={overrides}
                    onOverride={(key, action) =>
                      setOverrides((o) => {
                        const next = { ...o };
                        if (action) next[key] = action;
                        else delete next[key];
                        return next;
                      })
                    }
                  />
                </TransferCard>
              );
            })}

          <TransferCard title="Options">
            <Checkbox
              label="Keep published content published"
              hint="Needs the Publish content permission. Otherwise everything imported arrives as a draft."
              checked={keepStatus}
              onChange={(e) => setKeepStatus(e.target.checked)}
            />
            <Checkbox
              label="Import copies as drafts"
              checked={copiesAsDrafts}
              onChange={(e) => setCopiesAsDrafts(e.target.checked)}
            />
            {summary.groups.some((g) => g.group === 'users' || g.group === 'customers') ? (
              <Checkbox
                label="Import password hashes"
                hint="Needs the “Move admin accounts” permission. Otherwise imported accounts must set a new password; two-factor sign-in never transfers."
                checked={withHashes}
                onChange={(e) => setWithHashes(e.target.checked)}
              />
            ) : null}
          </TransferCard>

          {summary.groups.some((g) => g.pii) ? (
            <PiiConsent
              message={`This package holds personal data (${summary.groups
                .filter((g) => g.pii)
                .map((g) => groups.find((x) => x.key === g.group)?.label ?? g.label)
                .join(', ')}). Importing it copies that data to this site.`}
              checked={piiOk}
              onChange={setPiiOk}
            />
          ) : null}

          <ActionBar summary={describeSelection(size)}>
            <Button
              disabled={busy || blockers.length > 0 || (size.wholeGroups === 0 && size.items === 0)}
              onClick={plan}
            >
              {busy ? 'Preparing…' : 'Preview the import'}
            </Button>
          </ActionBar>
        </>
      ) : null}

      {step === 'dryrun' && dryRun ? (
        <>
          <DryRunSummary dryRun={dryRun} />
          <ActionBar summary={`${dryRun.total} ${dryRun.total === 1 ? 'item' : 'items'} to process`}>
            <Button variant="secondary" disabled={busy} onClick={() => setStep('choose')}>
              Back
            </Button>
            <Button disabled={busy || dryRun.total === 0} onClick={start}>
              Run the import
            </Button>
          </ActionBar>
        </>
      ) : null}

      {step === 'running' ? (
        <div className="flex flex-col gap-2">
          <Progress label="Importing" done={progress?.done ?? 0} total={progress?.total ?? 0} />
          {progress?.current ? (
            <p role="status" className="text-sm text-neutral-700">
              {progress.current}
            </p>
          ) : null}
          <div>
            <Button variant="danger" onClick={cancel}>
              Stop the import
            </Button>
          </div>
        </div>
      ) : null}

      {step === 'report' && report && id ? <ImportReportView id={id} rows={report} /> : null}
    </div>
  );
}
