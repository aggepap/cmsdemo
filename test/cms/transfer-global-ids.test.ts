import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { f } from '@/cms/config/fields';
import { regenerateAutoIds } from '@/cms/core/transfer/global-ids';

/**
 * A booking option's id keys its availability calendar (`res:<id>`). A COPY that
 * kept the original's option ids would share the original's calendar, and the
 * same yacht could be sold twice for one date. Every locale row of the copy must
 * get the SAME new ids, or the rows would disagree about which option is which.
 */

const fields = [
  f.repeater('options', [f.text('id', { hidden: true }), f.text('name', { localized: true })], {
    autoId: true,
    shared: true,
  }),
  f.repeater('prices', [f.text('option'), f.number('amount')]),
  f.repeater('plain', [f.text('id')]),
];

describe('regenerateAutoIds', () => {
  test('replaces autoId row ids and every other reference to them in the document', () => {
    let n = 0;
    const ids = new Map<string, string>();
    const gen = () => `new-${++n}`;
    const el = regenerateAutoIds(
      fields,
      {
        options: [{ id: 'o1', name: { el: 'α' } }, { id: 'o2' }],
        prices: [{ option: 'o2', amount: 5 }],
        plain: [{ id: 'o1x' }],
      },
      ids,
      gen
    );
    assert.deepEqual(el, {
      options: [{ id: 'new-1', name: { el: 'α' } }, { id: 'new-2' }],
      prices: [{ option: 'new-2', amount: 5 }],
      plain: [{ id: 'o1x' }],
    });

    const en = regenerateAutoIds(fields, { options: [{ id: 'o2' }, { id: 'o1' }] }, ids, gen);
    assert.deepEqual(
      en,
      { options: [{ id: 'new-2' }, { id: 'new-1' }] },
      'same map across locale rows'
    );
    assert.deepEqual(
      [...ids.entries()],
      [
        ['o1', 'new-1'],
        ['o2', 'new-2'],
      ]
    );
  });
});
