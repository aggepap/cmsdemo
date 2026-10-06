/**
 * Per-account lockout on the CUSTOMER sign-in.
 *
 * The storefront login had a per-IP rate limit and nothing else, which is the
 * one dimension an attacker controls freely: a proxy pool turns "ten guesses a
 * minute" into unlimited guesses against one shopper's password. The admin login
 * closed the same hole by counting failures per address in the audit log; this
 * pins that the customer login does the same, under its own actions so the two
 * populations never share a counter.
 *
 * The decision is pure and tested directly. The wiring lives in DB-bound code
 * this repo has no harness for, so it is pinned against the source, the way
 * `refund-webhook-wiring.test.ts` pins its own.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';

import { auditActionGroup } from '@/cms/core/audit-groups';
import { auditActionLabel, auditSubjectLabel } from '@/cms/core/audit-labels';
import {
  CUSTOMER_LOGIN_LOCKOUT,
  customerLoginSubject,
  isCustomerLoginLocked,
} from '@/cms/modules/customers/policy';

const source = (path: string) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*/g, '');

function fnBody(text: string, name: string): string {
  const start = text.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  const next = text.slice(start + 1).search(/\n(export )?(async )?function /);
  return text.slice(start, next < 0 ? undefined : start + 1 + next);
}

describe('isCustomerLoginLocked', () => {
  test('lets an address through while it is below the threshold', () => {
    assert.equal(isCustomerLoginLocked(0), false);
    assert.equal(isCustomerLoginLocked(CUSTOMER_LOGIN_LOCKOUT.maxFailures - 1), false);
  });

  test('refuses an address that has reached the threshold, and beyond it', () => {
    assert.equal(isCustomerLoginLocked(CUSTOMER_LOGIN_LOCKOUT.maxFailures), true);
    assert.equal(isCustomerLoginLocked(CUSTOMER_LOGIN_LOCKOUT.maxFailures + 25), true);
  });

  test('uses the same budget as the admin login: ten failures in fifteen minutes', () => {
    assert.equal(CUSTOMER_LOGIN_LOCKOUT.maxFailures, 10);
    assert.equal(CUSTOMER_LOGIN_LOCKOUT.windowMs, 15 * 60 * 1000);
  });

  test('treats a nonsense count as no failures rather than throwing', () => {
    // The count comes back from a database driver; a NaN must not lock anybody out.
    assert.equal(isCustomerLoginLocked(Number.NaN), false);
    assert.equal(isCustomerLoginLocked(-1), false);
  });
});

describe('customerLoginSubject', () => {
  test('is the normalised address itself while it fits the audit column', () => {
    assert.equal(customerLoginSubject('  Shopper@Example.COM '), 'shopper@example.com');
  });

  test('stays within the 64-character audit column for the longest address a customer may have', () => {
    // The customer email allows 191 characters and `audit_logs.subject_id` holds
    // 64. A row that does not fit is never written, and a failure that is never
    // written is never counted — unlimited guesses against a long address.
    const long = `${'a'.repeat(64)}@${'b'.repeat(120)}.example`;
    const subject = customerLoginSubject(long);
    assert.ok(subject.length <= 64, `${subject.length} characters`);
    assert.equal(customerLoginSubject(long.toUpperCase()), subject, 'case must not change the key');
    assert.notEqual(customerLoginSubject(`${long}x`), subject);
  });

  test('cannot be forged by a short address that looks like a hashed key', () => {
    const long = `${'a'.repeat(80)}@example.com`;
    const hashed = customerLoginSubject(long);
    // A real address can never equal the hashed form, because the hashed form is not an address.
    assert.doesNotMatch(hashed, /@/);
  });
});

describe('the customer login route', () => {
  const routes = source('src/cms/modules/customers/routes.ts');
  const body = fnBody(routes, 'customerLoginRoute');

  test('counts failures for the normalised address before it checks the password', () => {
    const count = body.indexOf('recentAuthFailures(');
    const check = body.indexOf('authenticateCustomer(');
    assert.ok(count >= 0, 'does not count recent failures');
    assert.ok(check > count, 'the lockout must be decided before the password is checked');
    assert.match(body, /customerLoginSubject\(input\.email\)/);
    assert.match(body, /isCustomerLoginLocked\(/);
  });

  test('refuses a locked address as a throttle, with no word about the account', () => {
    assert.match(body, /'rate_limited'/);
    assert.match(body, /Retry-After/);
    assert.match(body, /action: 'customer\.login\.locked'/);
  });

  test('records every failure — unknown address, wrong password, disabled — against the address', () => {
    assert.match(body, /action: 'customer\.login\.fail'/);
    // Recorded on `kind !== 'ok'`, not only on 'fail': a failure recorded only
    // for existing accounts would make the lockout itself an enumeration oracle.
    assert.match(body, /result\.kind !== 'ok'/);
    assert.match(body, /subjectType: CUSTOMER_EMAIL_SUBJECT/);
  });

  test('records a completed sign-in so the person who knows the password resets the count', () => {
    assert.match(body, /action: 'customer\.login\.success'/);
  });

  test('counts in its own subject type, never in the admin login\'s', () => {
    assert.match(routes, /CUSTOMER_EMAIL_SUBJECT = 'customer_email'/);
    assert.match(body, /subjectType: CUSTOMER_EMAIL_SUBJECT/);
    assert.match(body, /failAction: 'customer\.login\.fail'/);
    assert.match(body, /successAction: 'customer\.login\.success'/);
  });
});

describe('the shared failure counter', () => {
  test('filters on the subject type it is given, not a hard-coded one', () => {
    const body = fnBody(source('src/cms/core/audit.ts'), 'recentAuthFailures');
    assert.match(body, /eq\(schema\.auditLogs\.subjectType, actions\.subjectType \?\? 'email'\)/);
  });
});

describe('the audit screen', () => {
  test('files customer sign-in events with the other sign-ins, not with the shop', () => {
    for (const action of ['customer.login.fail', 'customer.login.success', 'customer.login.locked']) {
      assert.equal(auditActionGroup(action), 'signin', action);
    }
    // The rest of the customer events stay where they were.
    assert.equal(auditActionGroup('customer.export'), 'shop');
  });

  test('names the new actions and subject in words', () => {
    for (const action of ['customer.login.fail', 'customer.login.success', 'customer.login.locked']) {
      assert.match(auditActionLabel(action), /^[A-Z]/, action);
      assert.doesNotMatch(auditActionLabel(action), /customer\.login/, action);
    }
    assert.equal(auditSubjectLabel('customer_email'), 'Customer email address');
  });
});
