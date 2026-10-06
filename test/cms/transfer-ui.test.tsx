import '../setup/react-global';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { ConflictTable } from '@/cms/admin/transfer/ConflictTable';
import { DryRunSummary } from '@/cms/admin/transfer/DryRunSummary';
import { GroupPicker } from '@/cms/admin/transfer/GroupPicker';
import { ImportReportView } from '@/cms/admin/transfer/ImportReportView';
import { TransferManager } from '@/cms/admin/transfer/TransferManager';
import { emptySelection, selectionReducer } from '@/cms/admin/transfer/wizard-state';

/** Admin → Export / Import. */

const groups = [
  { key: 'media', label: 'Media files', pii: false },
  { key: 'settings', label: 'Settings', pii: false },
  { key: 'documents:product', label: 'Products', pii: false },
];

describe('TransferManager', () => {
  test('shows each direction only to someone allowed to use it', () => {
    const both = renderToStaticMarkup(
      <TransferManager groups={groups} canExport canImport targetLocales={['el']} />
    );
    assert.match(both, />Export</);
    assert.match(both, />Import</);
    const exportOnly = renderToStaticMarkup(
      <TransferManager groups={groups} canExport canImport={false} targetLocales={['el']} />
    );
    assert.doesNotMatch(exportOnly, /role="tab"[^>]*>Import</);
    assert.doesNotMatch(exportOnly, /Upload a package/);
  });

  test('recommends a backup before importing', () => {
    const html = renderToStaticMarkup(
      <TransferManager groups={groups} canExport={false} canImport targetLocales={['el']} />
    );
    assert.match(html, /backup/i);
  });
});

describe('GroupPicker', () => {
  test('offers nothing / everything / chosen items for each group, as labelled radios', () => {
    const state = selectionReducer(emptySelection(), { type: 'mode', group: 'media', mode: 'all' });
    const html = renderToStaticMarkup(
      <GroupPicker
        groups={groups}
        state={state}
        dispatch={() => undefined}
        renderItems={() => null}
      />
    );
    assert.match(html, /<fieldset/);
    assert.match(html, /<legend[^>]*>Media files/);
    assert.equal((html.match(/type="radio"/g) ?? []).length, 9);
    assert.match(html, /checked="" value="all"/);
  });
});

describe('ConflictTable', () => {
  const items = [
    {
      key: 'doc:product:a',
      label: 'Red shoe',
      state: 'conflict' as const,
      deps: [],
      match: { id: 1, label: 'red-shoe (el)' },
    },
    {
      key: 'doc:product:b',
      label: 'Blue shoe',
      state: 'ambiguous' as const,
      deps: [],
      match: { id: 2, label: 'blue-shoe (el, en)' },
    },
  ];

  test('lists each item that already exists here, with what it matches', () => {
    const html = renderToStaticMarkup(
      <ConflictTable
        items={items}
        allowed={['skip', 'overwrite', 'copy']}
        defaultAction="skip"
        overrides={{}}
        onOverride={() => undefined}
      />
    );
    assert.match(html, /Red shoe/);
    assert.match(html, /red-shoe \(el\)/);
    assert.match(html, /Matches more than one item/);
  });

  test('offers only the actions an item can take — an ambiguous match cannot be overwritten', () => {
    const html = renderToStaticMarkup(
      <ConflictTable
        items={items}
        allowed={['skip', 'overwrite', 'copy']}
        defaultAction="skip"
        overrides={{}}
        onOverride={() => undefined}
      />
    );
    const rows = html.split('<tr').slice(2);
    assert.match(rows[0], /value="overwrite"/);
    assert.doesNotMatch(rows[1], /value="overwrite"/);
    assert.match(rows[1], /value="copy"/);
  });

  test('each choice is labelled for assistive technology', () => {
    const html = renderToStaticMarkup(
      <ConflictTable
        items={items}
        allowed={['skip', 'overwrite', 'copy']}
        defaultAction="skip"
        overrides={{}}
        onOverride={() => undefined}
      />
    );
    assert.match(html, /aria-label="What to do with Red shoe"/);
  });
});

describe('DryRunSummary', () => {
  const dryRun = {
    summary: { create: 3, reuse: 0, overwrite: 1, copy: 0, skip: 2, merge: 0 },
    total: 6,
    required: [{ key: 'doc:category:c', label: 'Shoes', requiredBy: ['doc:product:a'] }],
    external: [{ key: 'doc:tag:t', label: 'sale (el, #9)', referencedBy: ['doc:product:a'] }],
    invalid: [{ key: 'doc:product:x', message: 'data.price: expected a number' }],
    warnings: [
      {
        key: 'setting:i18n.locales',
        message: 'Changes which languages this site edits and shows to visitors.',
      },
    ],
  };

  test('says what will be created, overwritten and skipped', () => {
    const html = renderToStaticMarkup(<DryRunSummary dryRun={dryRun} />);
    assert.match(html, /<dt[^>]*>Will be created<\/dt><dd[^>]*>3<\/dd>/);
    assert.match(html, /<dt[^>]*>Will be overwritten<\/dt><dd[^>]*>1<\/dd>/);
    assert.match(html, /<dt[^>]*>Will be skipped<\/dt><dd[^>]*>2<\/dd>/);
  });

  test('names references that will be dropped, invalid records and warnings', () => {
    const html = renderToStaticMarkup(<DryRunSummary dryRun={dryRun} />);
    assert.match(html, /sale \(el, #9\)/);
    assert.match(html, /data\.price: expected a number/);
    assert.match(html, /Changes which languages/);
  });
});

describe('ImportReportView', () => {
  test('failures are marked in words, not colour alone', () => {
    const html = renderToStaticMarkup(
      <ImportReportView
        id="11111111-1111-4111-8111-111111111111"
        rows={[
          {
            key: 'a',
            group: 'product',
            label: 'Red shoe',
            action: 'create',
            outcome: 'created',
            message: '',
            dropped: 0,
          },
          {
            key: 'b',
            group: 'product',
            label: 'Bad',
            action: 'create',
            outcome: 'failed',
            message: 'Too long',
            dropped: 0,
          },
        ]}
      />
    );
    assert.match(html, /Failed/);
    assert.match(html, /Too long/);
    assert.match(html, /format=csv/);
  });
});

describe('PiiConsent', () => {
  test('says what personal data is involved and asks for an explicit, labelled yes', async () => {
    const { PiiConsent } = await import('@/cms/admin/transfer/PiiConsent');
    const html = renderToStaticMarkup(
      <PiiConsent message="This includes personal data (Orders)." checked={false} onChange={() => undefined} />
    );
    assert.match(html, /role="alert"|role="status"/);
    assert.match(html, /personal data \(Orders\)/);
    assert.match(html, /type="checkbox"/);
    assert.match(html, /allowed to move/);
  });
});

describe('GroupPicker, by module', () => {
  const byModule = [
    { key: 'media', label: 'Media files', pii: false, module: null },
    { key: 'documents:product', label: 'Products', pii: false, module: 'commerce' },
    { key: 'orders', label: 'Orders', pii: true, module: 'commerce' },
    {
      key: 'documents:booking',
      label: 'Experiences',
      pii: false,
      module: 'booking',
      moduleOff: true,
    },
  ];

  test('shows one labelled section per module, general first', () => {
    const html = renderToStaticMarkup(
      <GroupPicker
        groups={byModule}
        state={emptySelection()}
        dispatch={() => undefined}
        renderItems={() => null}
      />
    );
    const headings = [...html.matchAll(/<h3[^>]*>([^<]+)<\/h3>/g)].map((m) => m[1]);
    assert.deepEqual(headings, ['General', 'Commerce', 'Booking']);
    assert.match(html, /<section[^>]*aria-labelledby="[^"]*-module-commerce"/);
    assert.ok(html.indexOf('Products') < html.indexOf('Orders'));
    assert.ok(html.indexOf('Orders') < html.indexOf('Experiences'));
  });

  test('a switched-off module cannot be picked from, and shows what the caller says about it', () => {
    const html = renderToStaticMarkup(
      <GroupPicker
        groups={byModule}
        state={emptySelection()}
        dispatch={() => undefined}
        renderItems={() => null}
        sectionNote={(section) => (section.off ? <p>Booking is off here</p> : null)}
      />
    );
    const booking = html.slice(html.indexOf('-module-booking"'));
    assert.match(booking, /Booking is off here/);
    assert.equal((booking.match(/type="radio"/g) ?? []).length, 3);
    assert.equal((booking.match(/disabled=""/g) ?? []).length, 3);
    const commerce = html.slice(
      html.indexOf('-module-commerce"'),
      html.indexOf('-module-booking"')
    );
    assert.doesNotMatch(commerce, /disabled=""/);
  });
});

describe('ModuleNotice', () => {
  test('names the module and offers to turn it on to someone who may', async () => {
    const { ModuleNotice } = await import('@/cms/admin/transfer/ModuleNotice');
    const html = renderToStaticMarkup(
      <ModuleNotice module="commerce" count={12} canActivate busy={false} onActivate={() => undefined} />
    );
    assert.match(html, /role="status"/);
    assert.match(html, /Commerce module is off on this site/);
    assert.match(html, /12 item/);
    assert.match(html, /<button[^>]*>Turn on Commerce<\/button>/);
  });

  test('says who can turn it on, with no button, to someone who may not', async () => {
    const { ModuleNotice } = await import('@/cms/admin/transfer/ModuleNotice');
    const html = renderToStaticMarkup(
      <ModuleNotice module="booking" count={1} canActivate={false} busy={false} onActivate={() => undefined} />
    );
    assert.match(html, /Booking module is off on this site/);
    assert.doesNotMatch(html, /<button/);
    assert.match(html, /change Settings/);
  });
});

describe('GroupPicker, twice on one page', () => {
  test('the export and import pickers never share a radio group', () => {
    // Both tabs stay mounted; radios that share a name are one group across the page,
    // so a click in one picker would change the other.
    const picker = (
      <GroupPicker
        groups={groups}
        state={emptySelection()}
        dispatch={() => undefined}
        renderItems={() => null}
      />
    );
    const html = renderToStaticMarkup(
      <>
        {picker}
        {picker}
      </>
    );
    const names = [...html.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map(
      (m) => /name="([^"]+)"/.exec(m[0])?.[1]
    );
    assert.equal(names.length, 18);
    assert.equal(new Set(names).size, 6, 'three groups per picker, each with its own name');
  });
});

describe('WizardSteps', () => {
  test('marks the current step for assistive technology and the earlier ones as done', async () => {
    const { WizardSteps } = await import('@/cms/admin/transfer/WizardSteps');
    const html = renderToStaticMarkup(
      <WizardSteps label="Export steps" steps={['Choose', 'Review', 'Download']} current={1} />
    );
    assert.match(html, /<ol[^>]*aria-label="Export steps"/);
    assert.match(html, /aria-current="step"[^>]*>[\s\S]*?Review/);
    assert.equal((html.match(/aria-current/g) ?? []).length, 1);
    assert.match(html, /Choose[\s\S]*?done/);
  });
});

describe('ActionBar', () => {
  test('keeps the summary and the action together', async () => {
    const { ActionBar } = await import('@/cms/admin/transfer/ActionBar');
    const html = renderToStaticMarkup(
      <ActionBar summary="Everything in 2 groups">
        <button type="button">Review export</button>
      </ActionBar>
    );
    assert.match(html, /role="status"[^>]*>Everything in 2 groups/);
    assert.match(html, /sticky/);
    assert.match(html, /Review export/);
  });
});

describe('GroupPicker, as rows', () => {
  test('each group is a compact row whose choice is a segmented control of real radios', () => {
    const state = selectionReducer(emptySelection(), { type: 'mode', group: 'media', mode: 'all' });
    const html = renderToStaticMarkup(
      <GroupPicker
        groups={groups}
        state={state}
        dispatch={() => undefined}
        renderItems={() => null}
      />
    );
    // Radios stay real inputs, visually hidden inside their labels, so the keyboard
    // and screen readers get native radio behaviour.
    assert.match(html, /<input[^>]*class="[^"]*sr-only/);
    // A section says how many of its groups will take something.
    assert.match(html, /1 of 3 chosen/);
  });
});

describe('GroupPicker, whole-module actions', () => {
  const byModule = [
    { key: 'media', label: 'Media files', pii: false, module: null },
    { key: 'documents:product', label: 'Products', pii: false, module: 'commerce' },
    { key: 'orders', label: 'Orders', pii: true, module: 'commerce' },
    { key: 'documents:booking', label: 'Experiences', pii: false, module: 'booking', moduleOff: true },
  ];
  const render = (state = emptySelection()) =>
    renderToStaticMarkup(
      <GroupPicker groups={byModule} state={state} dispatch={() => undefined} renderItems={() => null} />
    );

  test('offers to select everything in a module, named for that module', () => {
    const html = render();
    assert.match(html, /<button[^>]*aria-label="Select all in Commerce"/);
    assert.match(html, /<button[^>]*aria-label="Select all in General"/);
  });

  // The buttons never disappear: one that vanished under the pointer would drop a
  // keyboard user's focus to the top of the page. One that does not apply says so.
  const disabled = (html: string, name: string) =>
    new RegExp(`<button[^>]*aria-disabled="true"[^>]*aria-label="${name}"|<button[^>]*aria-label="${name}"[^>]*aria-disabled="true"`).test(html);

  test('offers to clear a module only when something in it is chosen', () => {
    assert.ok(disabled(render(), 'Clear Commerce'));
    const some = selectionReducer(emptySelection(), {
      type: 'mode',
      group: 'orders',
      mode: 'all',
    });
    const html = render(some);
    assert.ok(!disabled(html, 'Clear Commerce'));
    assert.ok(!disabled(html, 'Select all in Commerce'), 'not everything is chosen yet');
  });

  test('offers to clear a module whose item list is open, even with nothing ticked yet', () => {
    const open = selectionReducer(emptySelection(), {
      type: 'mode',
      group: 'orders',
      mode: 'some',
    });
    assert.ok(!disabled(render(open), 'Clear Commerce'));
  });

  test('"select all" does nothing once everything in the module is chosen', () => {
    const all = selectionReducer(emptySelection(), {
      type: 'modeMany',
      groups: ['documents:product', 'orders'],
      mode: 'all',
    });
    const html = render(all);
    assert.ok(disabled(html, 'Select all in Commerce'));
    assert.ok(!disabled(html, 'Clear Commerce'));
  });

  test('a module that is off here offers neither', () => {
    const html = render();
    assert.doesNotMatch(html, /Select all in Booking/);
    assert.doesNotMatch(html, /Clear Booking/);
  });
});
