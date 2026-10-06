/**
 * How long submissions are kept, and who may read sensitive ones (eyelike R3-25).
 *
 * A prescription sent through a form is health data (GDPR art. 9). Two things
 * were missing: a way to say "delete these after N days" — submissions stayed
 * for ever, with no delete at all — and a way to mark a form type as sensitive,
 * so its content (and any attached file) is hidden from every role that lacks
 * the permission to read it.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  isSensitiveFormType,
  readFormsPolicy,
  redactSubmission,
  retentionCutoffs,
  type FormsPolicy,
} from '@/cms/core/forms/policy';

const DAY = 86_400_000;
const NOW = new Date('2026-10-05T12:00:00Z');

describe('readFormsPolicy', () => {
  test('nothing set: keep everything, nothing sensitive', () => {
    assert.deepEqual(readFormsPolicy(null, null, null), {
      retentionDays: null,
      sensitiveTypes: [],
      sensitiveRetentionDays: null,
    });
  });

  test('whole positive days only; anything else means keep', () => {
    assert.equal(readFormsPolicy('365', null, null).retentionDays, 365);
    assert.equal(readFormsPolicy(30, null, null).retentionDays, 30);
    for (const bad of ['0', '-5', 'abc', '', '1.5']) {
      assert.equal(readFormsPolicy(bad, null, null).retentionDays, null, bad);
    }
  });

  test('sensitive types: one per line or comma, trimmed, lower-case, deduplicated', () => {
    assert.deepEqual(
      readFormsPolicy(null, ' prescription \nPrescription, eye-test\n\n', '90').sensitiveTypes,
      ['prescription', 'eye-test']
    );
    assert.equal(readFormsPolicy(null, 'prescription', '90').sensitiveRetentionDays, 90);
  });
});

describe('isSensitiveFormType', () => {
  const policy = readFormsPolicy(null, 'prescription', null);
  test('matches the form type case-insensitively', () => {
    assert.equal(isSensitiveFormType('prescription', policy), true);
    assert.equal(isSensitiveFormType('Prescription', policy), true);
    assert.equal(isSensitiveFormType('contact', policy), false);
  });
});

describe('retentionCutoffs', () => {
  test('keep for ever: no cutoff at all', () => {
    assert.deepEqual(retentionCutoffs(readFormsPolicy(null, null, null), NOW), {
      general: null,
      sensitive: null,
    });
  });

  test('each cutoff is now minus its days', () => {
    const c = retentionCutoffs(readFormsPolicy('365', 'prescription', '90'), NOW);
    assert.equal(c.general?.getTime(), NOW.getTime() - 365 * DAY);
    assert.equal(c.sensitive?.getTime(), NOW.getTime() - 90 * DAY);
  });

  test('sensitive types without their own period follow the general one', () => {
    const c = retentionCutoffs(readFormsPolicy('365', 'prescription', null), NOW);
    assert.equal(c.sensitive?.getTime(), NOW.getTime() - 365 * DAY);
  });

  test('sensitive types can be purged even when everything else is kept', () => {
    const c = retentionCutoffs(readFormsPolicy(null, 'prescription', '30'), NOW);
    assert.equal(c.general, null);
    assert.equal(c.sensitive?.getTime(), NOW.getTime() - 30 * DAY);
  });
});

describe('redactSubmission', () => {
  const policy: FormsPolicy = readFormsPolicy(null, 'prescription', null);
  const row = {
    id: 9,
    formType: 'prescription',
    email: 'p@example.com',
    payload: { SPH: '-1.25', CYL: '-0.50' },
    notes: 'Called back',
    attachment: { name: 'rx.jpg', size: 1000, type: 'image/jpeg' },
  };

  test('a sensitive submission, for someone without the permission: no content, no file, no notes', () => {
    const out = redactSubmission(row, policy, false);
    assert.deepEqual(out.payload, {});
    assert.equal(out.attachment, null);
    assert.equal(out.notes, null);
    assert.equal(out.redacted, true);
    // What is left is enough to know someone wrote and to reply.
    assert.equal(out.email, 'p@example.com');
    assert.equal(out.formType, 'prescription');
  });

  test('with the permission, unchanged', () => {
    const out = redactSubmission(row, policy, true);
    assert.deepEqual(out.payload, row.payload);
    assert.equal(out.redacted, false);
  });

  test('an ordinary form type is never redacted', () => {
    const out = redactSubmission({ ...row, formType: 'contact' }, policy, false);
    assert.deepEqual(out.payload, row.payload);
    assert.equal(out.redacted, false);
  });

  test('a list row (no payload) loses its file name too', () => {
    const { payload: _p, notes: _n, ...summary } = row;
    void _p;
    void _n;
    const out = redactSubmission(summary, policy, false);
    assert.equal(out.attachment, null);
    assert.equal('payload' in out, false);
  });
});
