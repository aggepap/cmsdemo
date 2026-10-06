'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { ButtonLink } from '@/components/ui/Button';
import { track } from '@/lib/analytics/runtime';

import { accountPost } from './account-api';

/**
 * Spends the confirmation link from the email.
 *
 * A POST rather than a GET on the link itself, because mail scanners and link
 * previewers follow GETs: a one-time link that a security appliance opens
 * before the customer does is a link the customer finds already used. The page
 * loads, then posts the token once.
 */
export function VerifyClient({ token }: { token: string }) {
  const t = useTranslations('account');
  const [state, setState] = useState<'working' | 'done' | 'failed'>(token ? 'working' : 'failed');

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    accountPost('verify', { token }, t('linkInvalid'))
      .then((data) => {
        if (cancelled) return;
        // The account exists from this moment: registering only asks for the
        // email (and answers the same whether or not it was new), so this — the
        // confirmed link — is the sign-up that counts. Once per token.
        const eventId = (data as { analyticsEventId?: unknown } | undefined)?.analyticsEventId;
        track(
          'account_sign_up',
          {},
          {
            once: `account_sign_up:${token.slice(0, 16)}`,
            ...(typeof eventId === 'string' ? { eventId } : {}),
          },
        );
        setState('done');
      })
      .catch(() => {
        if (!cancelled) setState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [token, t]);

  if (state === 'working') {
    return (
      <p role="status" className="font-body text-text-muted text-sm">
        {t('verifying')}
      </p>
    );
  }

  if (state === 'failed') {
    return (
      <div className="flex flex-col items-start gap-4">
        <p role="alert" className="font-body text-sm text-red-700">
          {t('linkInvalid')}
        </p>
        <ButtonLink href="/account/login">{t('signIn')}</ButtonLink>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-start gap-4">
      <p role="status" className="font-body text-sm text-green-700">
        {t('emailConfirmed')}
      </p>
      <ButtonLink href="/account">{t('myAccount')}</ButtonLink>
    </div>
  );
}
