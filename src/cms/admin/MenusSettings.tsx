'use client';

import { useState } from 'react';

import {
  MENU_LABEL_MAX,
  MENU_LIMITS,
  MENUS_KEY,
  type MenuItemConfig,
} from '../core/settings/menus';
import { cmsApi } from './api-client';
import { apiErrorText } from './api-error-text';
import { moveItem, type EditableMenus } from './menu-editor-state';
import { Button, Checkbox, Field, Icon, IconButton, Section, TextInput } from './ui';

/**
 * Settings → Menus: the header and footer menus.
 *
 * Reordering is by "Move up" / "Move down" buttons rather than drag and drop:
 * they work from the keyboard and with a screen reader, and each names the
 * item it moves. The header may nest one level; the footer is flat. An empty
 * menu means the site keeps its built-in one, which is said on screen so an
 * empty list does not read as "no menu at all".
 */

type Which = 'header' | 'footer';

const emptyItem = (): MenuItemConfig => ({ label: {}, href: '', newTab: false });

/** How an item is named in its buttons' labels. */
function itemName(item: MenuItemConfig, locales: string[], fallback: string): string {
  for (const locale of locales) {
    const text = item.label[locale]?.trim();
    if (text) return text;
  }
  return fallback;
}

function ItemEditor({
  item,
  name,
  locales,
  index,
  count,
  onChange,
  onMove,
  onRemove,
  onAddChild,
}: {
  item: MenuItemConfig;
  name: string;
  locales: string[];
  index: number;
  count: number;
  onChange: (item: MenuItemConfig) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  /** Absent for an item that cannot take sub-items. */
  onAddChild?: () => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        {locales.map((locale) => (
          <Field key={locale} label={`Label (${locale.toUpperCase()})`} className="min-w-36 flex-1">
            <TextInput
              value={item.label[locale] ?? ''}
              maxLength={MENU_LABEL_MAX}
              onChange={(e) =>
                onChange({ ...item, label: { ...item.label, [locale]: e.target.value } })
              }
            />
          </Field>
        ))}
        <Field
          label="Link"
          description="A page on this site starting with / (e.g. /about), or a full https:// address."
          className="min-w-48 flex-[2]"
        >
          <TextInput
            value={item.href}
            placeholder="/about"
            onChange={(e) => onChange({ ...item, href: e.target.value })}
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Checkbox
          label="Open in a new tab"
          checked={item.newTab}
          onChange={(e) => onChange({ ...item, newTab: e.target.checked })}
        />
        <div className="ml-auto flex items-center gap-1">
          <IconButton
            aria-label={`Move “${name}” up`}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <Icon name="chevron-up" size={16} />
          </IconButton>
          <IconButton
            aria-label={`Move “${name}” down`}
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            <Icon name="chevron-down" size={16} />
          </IconButton>
          {onAddChild ? (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Add a sub-item under “${name}”`}
              disabled={(item.children?.length ?? 0) >= MENU_LIMITS.children}
              onClick={onAddChild}
            >
              <Icon name="plus" size={14} /> Sub-item
            </Button>
          ) : null}
          <IconButton aria-label={`Remove “${name}”`} onClick={onRemove}>
            <Icon name="trash" size={16} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

function MenuList({
  which,
  items,
  locales,
  onChange,
}: {
  which: Which;
  items: MenuItemConfig[];
  locales: string[];
  onChange: (items: MenuItemConfig[]) => void;
}) {
  const limit = MENU_LIMITS[which];
  const setAt = (index: number, item: MenuItemConfig) =>
    onChange(items.map((it, i) => (i === index ? item : it)));

  return (
    <div className="flex flex-col gap-3">
      {items.length === 0 ? (
        <p className="text-sm text-neutral-600">
          No items — the site shows its built-in {which} menu. Add an item to replace it with your
          own.
        </p>
      ) : (
        <ol className="flex flex-col gap-3">
          {items.map((item, index) => {
            const name = itemName(item, locales, `Item ${index + 1}`);
            const children = item.children ?? [];
            return (
              <li key={index} className="rounded-sm border border-neutral-200 p-3">
                <ItemEditor
                  item={item}
                  name={name}
                  locales={locales}
                  index={index}
                  count={items.length}
                  onChange={(next) => setAt(index, next)}
                  onMove={(delta) => onChange(moveItem(items, index, delta))}
                  onRemove={() => onChange(items.filter((_, i) => i !== index))}
                  onAddChild={
                    which === 'header'
                      ? () => setAt(index, { ...item, children: [...children, emptyItem()] })
                      : undefined
                  }
                />
                {children.length > 0 ? (
                  <ol
                    aria-label={`Sub-items of “${name}”`}
                    className="mt-3 flex flex-col gap-3 border-l-2 border-neutral-200 pl-4"
                  >
                    {children.map((child, ci) => (
                      <li key={ci}>
                        <ItemEditor
                          item={child}
                          name={itemName(child, locales, `Sub-item ${ci + 1}`)}
                          locales={locales}
                          index={ci}
                          count={children.length}
                          onChange={(next) =>
                            setAt(index, {
                              ...item,
                              children: children.map((c, j) => (j === ci ? next : c)),
                            })
                          }
                          onMove={(delta) =>
                            setAt(index, { ...item, children: moveItem(children, ci, delta) })
                          }
                          onRemove={() =>
                            setAt(index, { ...item, children: children.filter((_, j) => j !== ci) })
                          }
                        />
                      </li>
                    ))}
                  </ol>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      <div>
        <Button
          variant="secondary"
          size="sm"
          disabled={items.length >= limit}
          onClick={() => onChange([...items, emptyItem()])}
        >
          <Icon name="plus" size={14} /> Add item
        </Button>
      </div>
    </div>
  );
}

export function MenusSettings({ initial, locales }: { initial: EditableMenus; locales: string[] }) {
  const [menus, setMenus] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await cmsApi.updateSiteSettings({ [MENUS_KEY]: menus });
      setSaved(true);
    } catch (err) {
      setError(apiErrorText(err, 'Could not save the menus.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Header menu"
        info={`Up to ${MENU_LIMITS.header} items, each with up to ${MENU_LIMITS.children} sub-items that open from it. Once you add items, the menu is exactly what you set here: shop and booking links are no longer added for you.`}
      >
        <MenuList
          which="header"
          items={menus.header}
          locales={locales}
          onChange={(header) => setMenus({ ...menus, header })}
        />
      </Section>
      <Section
        title="Footer menu"
        info={`The “Explore” links in the footer, up to ${MENU_LIMITS.footer}. The legal links (privacy, terms, cookies) always stay.`}
      >
        <MenuList
          which="footer"
          items={menus.footer}
          locales={locales}
          onChange={(footer) => setMenus({ ...menus, footer })}
        />
      </Section>
      {error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="text-sm text-green-700">
          Saved.
        </p>
      ) : null}
      <div>
        <Button type="button" onClick={() => void save()} disabled={saving}>
          Save menus
        </Button>
      </div>
    </div>
  );
}
