/**
 * Contact-form recipients come from Settings (F-009).
 *
 * `notifications.inquiryEmails` says it is for "form + quote notifications", but
 * only the shop read it: the contact form always went to the env
 * `CONTACT_RECIPIENT_EMAIL`, so an owner who changed the address in the admin
 * kept not receiving enquiries.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { graphToRecipients, parseRecipients } from '@/cms/core/email/format';

describe('parseRecipients', () => {
  test('splits on commas and new lines and trims', () => {
    assert.deepEqual(parseRecipients('a@x.gr, b@x.gr\nc@x.gr\r\n'), ['a@x.gr', 'b@x.gr', 'c@x.gr']);
  });

  test('drops entries that are not addresses, and duplicates', () => {
    assert.deepEqual(parseRecipients('a@x.gr,,nobody, a@x.gr'), ['a@x.gr']);
  });

  test('anything but a string is no recipients', () => {
    assert.deepEqual(parseRecipients(null), []);
    assert.deepEqual(parseRecipients(42), []);
  });
});

describe('graphToRecipients', () => {
  test('one address, a list, or the default when none is given', () => {
    const one = (address: string) => ({ emailAddress: { address } });
    assert.deepEqual(graphToRecipients('a@x.gr', 'd@x.gr'), [one('a@x.gr')]);
    assert.deepEqual(graphToRecipients(['a@x.gr', 'b@x.gr'], 'd@x.gr'), [one('a@x.gr'), one('b@x.gr')]);
    assert.deepEqual(graphToRecipients(undefined, 'd@x.gr'), [one('d@x.gr')]);
    assert.deepEqual(graphToRecipients([], 'd@x.gr'), [one('d@x.gr')]);
  });
});

describe('wiring', () => {
  const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

  test('the contact route sends to the configured recipients', () => {
    const src = read('src/app/api/contact/route.ts');
    assert.match(src, /getSetting\('notifications\.inquiryEmails'\)/);
    assert.match(src, /to: parseRecipients\(/);
  });

  test('the Graph sender builds its recipients with graphToRecipients', () => {
    assert.match(read('src/cms/core/email/graph.ts'), /toRecipients: graphToRecipients\(mail\.to, env\.defaultRecipient\)/);
  });

  test('the shop uses the shared parser instead of its own copy', () => {
    assert.doesNotMatch(read('src/cms/modules/commerce/orders.ts'), /function parseRecipients/);
  });
});
