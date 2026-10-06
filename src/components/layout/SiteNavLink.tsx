'use client';

import { useTranslations } from 'next-intl';
import type { MouseEventHandler } from 'react';

import { safeHref } from '@/components/ui/Button';
import { Link } from '@/lib/i18n/routing';
import type { NavLink } from '@/lib/nav-links';

/**
 * One menu entry. An in-site path goes through the locale-aware `Link`; an
 * https URL is a plain anchor. A new tab only when the admin asked for one,
 * and then announced to screen readers and without handing over the opener.
 *
 * `safeHref` again here, although the setting is validated on write and read:
 * this is the line that puts the value in the DOM.
 */
export function SiteNavLink({
  link,
  className,
  onClick,
}: {
  link: NavLink;
  className?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
}) {
  const t = useTranslations('links');
  const href = safeHref(link.href);

  if (link.newTab) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        onClick={onClick}
      >
        {link.label}
        <span className="sr-only"> ({t('newTab')})</span>
      </a>
    );
  }
  if (href.startsWith('https://')) {
    return (
      <a href={href} className={className} onClick={onClick}>
        {link.label}
      </a>
    );
  }
  return (
    <Link href={href} className={className} onClick={onClick}>
      {link.label}
    </Link>
  );
}
