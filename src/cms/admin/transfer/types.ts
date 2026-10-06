/**
 * The shapes the transfer API answers with, as the admin sees them. Mirrors
 * `src/cms/core/transfer` without importing its server modules into the browser.
 */
import type { MatchState, TransferAction } from '../../core/transfer/conflicts';

export type { MatchState, TransferAction };

export interface GroupOption {
  key: string;
  label: string;
  pii: boolean;
  /** The module the group belongs to, or null (or absent) for what every site has. */
  module?: string | null;
  /** That module is switched off on this site. */
  moduleOff?: boolean;
}

export interface CatalogItem {
  key: string;
  label: string;
  meta?: string | null;
}

export interface Selection {
  groups: Record<string, 'all' | string[]>;
  optOut: string[];
}

export interface ExportPreview {
  total: number;
  counts: Record<string, number>;
  /** Set when the package would hold personal data. */
  pii: string | null;
  required: Array<{ key: string; label: string; group: string | null; requiredBy: string[] }>;
  external: Array<{ key: string; label: string; group: string | null; referencedBy: string[] }>;
}

export interface ExportProgress {
  id: string;
  phase: 'building' | 'done' | 'failed';
  done: number;
  total: number;
  warnings?: string[];
  error?: string;
}

export interface ImportItem {
  key: string;
  label: string;
  state: MatchState;
  deps: string[];
  invalid?: string;
  warning?: string | null;
  match?: { id: number | string; label: string } | null;
}

export interface ImportGroupSummary {
  group: string;
  label: string;
  total: number;
  conflicts: number;
  invalid: number;
  available: boolean;
  pii: boolean;
  /** Absent in an analysis made before modules were reported. */
  module?: string | null;
  moduleOff?: boolean;
}

export interface ImportSummary {
  source: {
    siteName: string;
    origin: string;
    createdAt: string;
    cmsVersion: string;
    locales: string[];
    defaultLocale: string;
  };
  containsPii: boolean;
  compatibility: { blockers: string[]; warnings: string[] };
  localeMap: Record<string, string | null>;
  targetLocales: string[];
  groups: ImportGroupSummary[];
}

export interface DryRun {
  summary: Record<TransferAction | 'create' | 'reuse', number>;
  total: number;
  required: Array<{ key: string; label: string; requiredBy: string[] }>;
  external: Array<{ key: string; label: string; referencedBy: string[] }>;
  invalid: Array<{ key: string; message: string }>;
  warnings: Array<{ key: string; message: string }>;
}

export interface ImportProgress {
  phase: 'ready' | 'running' | 'patching' | 'done' | 'cancelled';
  done: number;
  total: number;
  current?: string;
}

export type Outcome =
  | 'created'
  | 'updated'
  | 'copied'
  | 'merged'
  | 'skipped'
  | 'reused'
  | 'failed'
  | 'pending';

export interface ReportRow {
  key: string;
  group: string;
  label: string;
  action: string;
  outcome: Outcome;
  message: string;
  dropped: number;
}

export interface TransferJob {
  id: string;
  kind: 'import' | 'export';
  createdAt: string;
  info: { phase: string | null; filename: string | null };
}

export interface ImportOptions {
  localeMap: Record<string, string | null>;
  keepStatus: boolean;
  copiesAsDrafts: boolean;
  acknowledgePii?: boolean;
  importPasswordHashes?: boolean;
}

export interface ImportDecisions {
  selection: Selection;
  defaults: Record<string, TransferAction>;
  overrides: Record<string, TransferAction>;
}
