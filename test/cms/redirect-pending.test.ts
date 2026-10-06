import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  isPendingRedirect,
  notFoundLink,
  pendingActivationProblem,
  publicNotFoundPath,
} from '@/cms/core/seo/pending';

/**
 * A pending mapping: an old URL written down with no target yet. Stored as a
 * redirect row with an empty target that is never active, so the resolver —
 * which only reads active rows — cannot serve it.
 */

const rule = (id: number, source: string, target: string, active = true, kind = 'literal') => ({
  id,
  source,
  target,
  active,
  kind,
});

describe('pending redirects', () => {
  test('a row with no target is pending; a disabled row with a target is merely disabled', () => {
    assert.equal(isPendingRedirect({ target: '' }), true);
    assert.equal(isPendingRedirect({ target: '/x' }), false);
  });

  test('a pending row cannot be switched on without a target', () => {
    assert.match(pendingActivationProblem({ target: '' }, { active: true }) ?? '', /target/i);
    assert.equal(pendingActivationProblem({ target: '' }, { active: true, target: '/new' }), null);
    assert.equal(pendingActivationProblem({ target: '/x' }, { active: true }), null);
    assert.equal(pendingActivationProblem({ target: '' }, { notes: 'later' }), null);
  });
});

describe('the 404 monitor and the redirect list', () => {
  test('a 404 in the main language is its own path; in another language it carries the prefix', () => {
    assert.equal(publicNotFoundPath({ path: '/old', locale: 'el' }, 'el'), '/old');
    assert.equal(publicNotFoundPath({ path: '/old', locale: null }, 'el'), '/old');
    assert.equal(publicNotFoundPath({ path: '/old', locale: 'en' }, 'el'), '/en/old');
  });

  test('a 404 whose path is waiting in the pending list shows as pending', () => {
    assert.deepEqual(notFoundLink('/old/', [rule(4, '/old', '', false)]), { state: 'pending', redirectId: 4 });
  });

  test('a 404 now covered by an active redirect shows where it goes', () => {
    assert.deepEqual(notFoundLink('/old', [rule(4, '/old', '/new')]), {
      state: 'redirected',
      redirectId: 4,
      target: '/new',
    });
    assert.deepEqual(notFoundLink('/docs/a', [rule(5, '/docs/*', '/help', true, 'wildcard')]), {
      state: 'redirected',
      redirectId: 5,
      target: '/help',
    });
  });

  test('a disabled redirect does not count as resolving the 404', () => {
    assert.equal(notFoundLink('/old', [rule(4, '/old', '/new', false)]), null);
  });

  test('nothing listed means no link', () => {
    assert.equal(notFoundLink('/old', []), null);
  });
});
