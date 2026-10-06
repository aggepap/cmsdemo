import { Badge, Table, Tbody, Td, Th, Thead } from '../ui';
import { OUTCOME_LABELS } from './labels';
import type { Outcome, ReportRow } from './types';

const TONE: Record<Outcome, 'green' | 'blue' | 'neutral' | 'red' | 'amber'> = {
  created: 'green',
  updated: 'blue',
  copied: 'green',
  merged: 'blue',
  skipped: 'neutral',
  reused: 'neutral',
  failed: 'red',
  pending: 'amber',
};

/** What the import did, item by item. Every outcome is a word, not just a colour. */
export function ImportReportView({ id, rows }: { id: string; rows: ReportRow[] }) {
  const failed = rows.filter((r) => r.outcome === 'failed').length;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" className="text-sm text-neutral-800">
          {rows.length} item(s) processed{failed ? `, ${failed} failed` : ''}.
        </p>
        <a
          href={`/api/cms/transfer/imports/${id}/report?format=csv`}
          className="text-warm-gold-deep text-sm font-medium underline underline-offset-2"
        >
          Download the report (CSV)
        </a>
      </div>
      <Table>
        <Thead>
          <tr>
            <Th>Group</Th>
            <Th>Item</Th>
            <Th>Outcome</Th>
            <Th>Notes</Th>
          </tr>
        </Thead>
        <Tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <Td className="text-neutral-600">{r.group}</Td>
              <Td className="font-medium text-neutral-900">{r.label}</Td>
              <Td>
                <Badge tone={TONE[r.outcome]}>{OUTCOME_LABELS[r.outcome]}</Badge>
              </Td>
              <Td className="text-neutral-700">
                {r.message}
                {r.dropped
                  ? ` ${r.dropped} link(s) had nothing to point to here and were removed.`
                  : ''}
              </Td>
            </tr>
          ))}
        </Tbody>
      </Table>
    </div>
  );
}
