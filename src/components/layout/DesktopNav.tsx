'use client';

import { ChevronDown } from 'lucide-react';

import { SiteNavLink } from '@/components/layout/SiteNavLink';
import type { NavLink } from '@/lib/nav-links';

const itemClass =
  'px-3 py-2 text-sm font-medium text-text-primary hover:text-warm-gold-deep transition-colors whitespace-nowrap';

/**
 * The header's primary navigation from `md` up.
 *
 * A parent with sub-items opens its list on hover and on keyboard focus
 * (`focus-within`): tabbing onto the parent reveals the children, and the next
 * Tab moves into them. The list is `invisible` rather than unmounted, so it is
 * out of the tab order only while closed. The parent stays a real link.
 */
export function DesktopNav({ links, label }: { links: NavLink[]; label: string }) {
  return (
    <nav className="hidden md:block" aria-label={label}>
      <ul className="flex items-center gap-1">
        {links.map((link) =>
          link.children.length === 0 ? (
            <li key={link.key}>
              <SiteNavLink link={link} className={itemClass} />
            </li>
          ) : (
            <li key={link.key} className="group relative">
              <span className="flex items-center">
                <SiteNavLink link={link} className={itemClass} />
                <ChevronDown className="text-text-muted -ml-2 h-4 w-4" aria-hidden />
              </span>
              <ul className="border-border-soft bg-soft-pearl invisible absolute top-full left-0 z-50 min-w-48 rounded-sm border py-2 opacity-0 shadow-md transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100">
                {link.children.map((child) => (
                  <li key={child.key}>
                    <SiteNavLink link={child} className={`block ${itemClass}`} />
                  </li>
                ))}
              </ul>
            </li>
          )
        )}
      </ul>
    </nav>
  );
}
