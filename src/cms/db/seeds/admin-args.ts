/**
 * Arguments for `npm run db:seed-admin -- <email> <password> [name] [--locale <code>]`,
 * or `<email> [name] --password-stdin` with the password piped in.
 *
 * Kept apart from the CLI so it can be tested without a database. `--locale` sets
 * the language of the admin's sign-in code emails; without it the column's
 * database default applies.
 *
 * `--password-stdin` exists because a password typed as an argument lands in
 * shell history and in `ps` output for anyone on the machine. With it, `password`
 * is `null` here and the CLI reads it from standard input.
 */
export interface AdminArgs {
  email: string;
  password: string | null;
  name: string | undefined;
  locale: string | undefined;
}

export const ADMIN_ARGS_USAGE =
  'Usage: npm run db:seed-admin -- <email> <password> [name] [--locale <code>]\n' +
  '   or: npm run db:seed-admin -- <email> [name] --password-stdin [--locale <code>]';

/** A BCP-47-ish language code: `en`, `el`, `pt-BR`. */
const LOCALE_CODE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;

export function parseAdminArgs(argv: readonly string[]): AdminArgs {
  const positional: string[] = [];
  let locale: string | undefined;
  let fromStdin = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--locale' || arg.startsWith('--locale=')) {
      const value = arg === '--locale' ? argv[++i] : arg.slice('--locale='.length);
      if (!value || !LOCALE_CODE.test(value)) {
        throw new Error(`--locale needs a language code such as "en" (got ${JSON.stringify(value ?? '')}).`);
      }
      locale = value;
    } else if (arg === '--password-stdin') {
      fromStdin = true;
    } else {
      positional.push(arg);
    }
  }

  if (fromStdin) {
    // A third positional would be a password typed anyway: refuse it rather than
    // read it as the name and leave it sitting in the shell history regardless.
    const [email, name] = positional;
    if (!email || positional.length > 2) throw new Error(ADMIN_ARGS_USAGE);
    return { email, password: null, name, locale };
  }

  const [email, password, name] = positional;
  if (!email || !password) throw new Error(ADMIN_ARGS_USAGE);
  return { email, password, name, locale };
}

/**
 * The password from what was piped in: everything but the one line ending that
 * `echo`, a heredoc or a file adds. Other whitespace is part of the password.
 */
export function passwordFromStdin(input: string): string {
  const password = input.replace(/\r?\n$/, '');
  if (!password) throw new Error('--password-stdin: no password on standard input.');
  return password;
}

/**
 * What `db:seed-admin` must do to leave the account holding exactly `superadmin`.
 *
 * The command's promise is "grants the superadmin role". It used to grant it only
 * to an account with no role at all, so re-running it for an existing editor
 * printed "Done" and left them an editor. An account holds one role, so another
 * role is replaced rather than joined.
 */
export function superadminGrant(currentRoleIds: readonly number[], superadminRoleId: number): 'none' | 'grant' | 'replace' {
  if (currentRoleIds.length === 0) return 'grant';
  if (currentRoleIds.length === 1 && currentRoleIds[0] === superadminRoleId) return 'none';
  return 'replace';
}
