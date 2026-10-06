'use client';

import { actionsFor } from '../../core/transfer/conflicts';
import { Badge, Select, Table, Tbody, Td, Th, Thead } from '../ui';
import { ACTION_LABELS, STATE_LABELS } from './labels';
import type { ImportItem, TransferAction } from './types';

/**
 * The items of one group that already exist on this site, each with its own
 * choice. Only the actions the item can take are offered — the server refuses
 * anything else, so offering it would only produce an error later.
 */
export function ConflictTable({
  items,
  allowed,
  defaultAction,
  overrides,
  onOverride,
}: {
  items: ImportItem[];
  allowed: readonly TransferAction[];
  defaultAction: TransferAction;
  overrides: Record<string, TransferAction>;
  onOverride: (key: string, action: TransferAction | null) => void;
}) {
  if (items.length === 0)
    return <p className="text-sm text-neutral-600">Nothing in this group exists here yet.</p>;
  return (
    <Table>
      <Thead>
        <tr>
          <Th>Item</Th>
          <Th>On this site</Th>
          <Th>What to do</Th>
        </tr>
      </Thead>
      <Tbody>
        {items.map((item) => {
          const possible = actionsFor(item.state, allowed);
          const fallback = possible.includes(defaultAction) ? defaultAction : 'skip';
          return (
            <tr key={item.key} className="bg-amber-50/40">
              <Td className="font-medium text-neutral-900">{item.label}</Td>
              <Td>
                <span className="flex flex-col gap-1">
                  <Badge tone={item.state === 'conflict' ? 'amber' : 'red'}>
                    {STATE_LABELS[item.state]}
                  </Badge>
                  {item.match ? (
                    <span className="text-xs text-neutral-600">{item.match.label}</span>
                  ) : null}
                </span>
              </Td>
              <Td>
                <Select
                  aria-label={`What to do with ${item.label}`}
                  value={overrides[item.key] ?? ''}
                  onChange={(e) =>
                    onOverride(item.key, e.target.value ? (e.target.value as TransferAction) : null)
                  }
                >
                  <option value="">Default: {ACTION_LABELS[fallback]}</option>
                  {possible.map((action) => (
                    <option key={action} value={action}>
                      {ACTION_LABELS[action]}
                    </option>
                  ))}
                </Select>
              </Td>
            </tr>
          );
        })}
      </Tbody>
    </Table>
  );
}
