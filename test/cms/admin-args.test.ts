import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseAdminArgs, passwordFromStdin } from '@/cms/db/seeds/admin-args';

/**
 * `npm run db:seed-admin -- <email> <password> [name] [--locale <code>]`
 *
 * The admin's locale decides the language of their sign-in code emails. Without
 * the flag the column's database default applies, which is Greek — wrong for the
 * first admin of an English-first site, so the scaffold passes the site's main
 * language here.
 */

describe('parseAdminArgs', () => {
  test('email and password are required', () => {
    assert.throws(() => parseAdminArgs([]), /Usage/);
    assert.throws(() => parseAdminArgs(['a@b.co']), /Usage/);
  });

  test('the name is optional and positional', () => {
    assert.deepEqual(parseAdminArgs(['a@b.co', 'pw']), { email: 'a@b.co', password: 'pw', name: undefined, locale: undefined });
    assert.deepEqual(parseAdminArgs(['a@b.co', 'pw', 'Ann Lee']), {
      email: 'a@b.co',
      password: 'pw',
      name: 'Ann Lee',
      locale: undefined,
    });
  });

  test('--locale sets the admin language, before or after the name, in either form', () => {
    assert.equal(parseAdminArgs(['a@b.co', 'pw', '--locale', 'en']).locale, 'en');
    assert.equal(parseAdminArgs(['a@b.co', 'pw', 'Ann', '--locale=en']).locale, 'en');
    assert.equal(parseAdminArgs(['--locale', 'en', 'a@b.co', 'pw', 'Ann']).name, 'Ann');
  });

  test('a malformed locale is refused rather than stored', () => {
    assert.throws(() => parseAdminArgs(['a@b.co', 'pw', '--locale', 'english!']), /locale/);
    assert.throws(() => parseAdminArgs(['a@b.co', 'pw', '--locale']), /locale/);
  });
});

/**
 * A password on the command line lands in shell history and in `ps` output for
 * anyone on the box. `--password-stdin` reads it from standard input instead,
 * the way `docker login --password-stdin` does, and drops it from the positionals.
 */
describe('parseAdminArgs --password-stdin', () => {
  test('takes the password from stdin, so the positionals are <email> [name]', () => {
    assert.deepEqual(parseAdminArgs(['a@b.co', '--password-stdin']), {
      email: 'a@b.co',
      password: null,
      name: undefined,
      locale: undefined,
    });
    assert.equal(parseAdminArgs(['a@b.co', 'Ann Lee', '--password-stdin']).name, 'Ann Lee');
  });

  test('still requires the email', () => {
    assert.throws(() => parseAdminArgs(['--password-stdin']), /Usage/);
  });

  test('a password on the command line as well is refused, not silently ignored', () => {
    assert.throws(() => parseAdminArgs(['a@b.co', 'pw', 'Ann', '--password-stdin']), /Usage/);
  });
});

describe('passwordFromStdin', () => {
  test('strips the one line ending a pipe or a heredoc adds', () => {
    assert.equal(passwordFromStdin('S3cret-pass!\n'), 'S3cret-pass!');
    assert.equal(passwordFromStdin('S3cret-pass!\r\n'), 'S3cret-pass!');
  });

  test('keeps spaces that are part of the password', () => {
    assert.equal(passwordFromStdin('  two words  \n'), '  two words  ');
  });

  test('empty input is an error, not an empty password', () => {
    assert.throws(() => passwordFromStdin(''), /password/i);
    assert.throws(() => passwordFromStdin('\n'), /password/i);
  });
});
