/**
 * The Google Tag Manager container the admin downloads (REQ-5 §5) — in GTM's
 * import format (Admin → Import Container), built from the same settings the
 * site runs on.
 *
 * What goes in:
 *   variables  a Data Layer Variable per parameter the active events carry,
 *              `cms_ga4_id`, the Pixel ID (`cms_meta_pixel_id`), `event_id`
 *              and `cms_meta.params` (the Meta parameters, mapped by the CMS)
 *   triggers   one Custom Event trigger per active event
 *   tags       the Google tag + one GA4 Event tag per GA4-enabled event — only
 *              when GA4 goes through GTM; one Meta tag per Meta-enabled event —
 *              only when the Pixel goes through GTM; a Google Ads conversion per
 *              event with a label, plus the Conversion Linker
 *   template   "CMS · Meta Pixel", inside the same JSON
 *
 * A destination the CMS already loads itself gets no tags here: that is the
 * "never counted twice" rule, from the container's side.
 *
 * Every name starts `CMS · ` and depends only on the settings, so the next
 * import with "Overwrite conflicting…" replaces each entity instead of adding a
 * copy. An event switched off is simply absent from the next export — and an
 * import never deletes, so `staleGtmEntities` lists what to remove by hand.
 *
 * Pure: no database, no clock (the export time is passed in).
 */
import { EVENT_CATALOG, COMMON_EVENT_PARAMS, type EventSwitches } from './catalog';
import { TRIGGER_PARAMS, type CustomEvent } from './custom-events';
import type { GoogleAdsSettings } from './google-ads';

/** The settings key holding the entity names of the last download. Machine state. */
export const GTM_LAST_EXPORT_KEY = 'analytics.gtmLastExport';

export interface GtmExportInput {
  gtmId: string;
  ga4ViaGtm: boolean;
  pixelViaGtm: boolean;
  pixelId: string | null;
  switches: EventSwitches;
  customEvents: readonly CustomEvent[];
  googleAds: GoogleAdsSettings;
  exportTime: Date;
}

const PREFIX = 'CMS · ';
/** GTM's built-in trigger ids. */
const ALL_PAGES = '2147479553';
const INITIALIZATION_ALL_PAGES = '2147479573';
const TEMPLATE_ID = '1';

type Param =
  | { type: 'TEMPLATE' | 'BOOLEAN' | 'INTEGER'; key: string; value: string }
  | { type: 'LIST'; key: string; list: unknown[] };

interface Variable {
  accountId: string;
  containerId: string;
  variableId: string;
  name: string;
  type: string;
  parameter: Param[];
}

interface Trigger {
  accountId: string;
  containerId: string;
  triggerId: string;
  name: string;
  type: 'CUSTOM_EVENT';
  customEventFilter: unknown[];
  filter?: unknown[];
}

interface Tag {
  accountId: string;
  containerId: string;
  tagId: string;
  name: string;
  type: string;
  parameter: Param[];
  firingTriggerId: string[];
  tagFiringOption: 'ONCE_PER_EVENT';
  consentSettings: { consentStatus: 'NEEDED'; consentType: { type: 'LIST'; list: { type: 'TEMPLATE'; value: string }[] } };
}

export interface GtmContainerExport {
  exportFormatVersion: 2;
  exportTime: string;
  containerVersion: Record<string, unknown>;
}

const ids = { accountId: '0', containerId: '0' };

const tpl = (key: string, value: string): Param => ({ type: 'TEMPLATE', key, value });
const bool = (key: string, value: boolean): Param => ({ type: 'BOOLEAN', key, value: String(value) });
const ref = (variable: string) => `{{${PREFIX}${variable}}}`;
const dlvName = (param: string) => `DLV · ${param}`;

function consent(type: 'analytics_storage' | 'ad_storage'): Tag['consentSettings'] {
  return { consentStatus: 'NEEDED', consentType: { type: 'LIST', list: [{ type: 'TEMPLATE', value: type }] } };
}

function equals(left: string, right: string) {
  return {
    type: 'EQUALS',
    parameter: [
      { type: 'TEMPLATE', key: 'arg0', value: left },
      { type: 'TEMPLATE', key: 'arg1', value: right },
    ],
  };
}

/** An event the container handles: a catalogue event or a custom one. */
interface ExportEvent {
  id: string;
  name: string;
  params: string[];
  ga4: boolean;
  meta: { name: string; method: 'track' | 'trackCustom' } | null;
  /** Extra trigger condition (the two `sign_up`s are told apart by `method`). */
  method?: string;
}

function exportEvents(input: GtmExportInput): ExportEvent[] {
  const out: ExportEvent[] = [];
  for (const e of EVENT_CATALOG) {
    if (e.serverOnly) continue;
    const sw = input.switches[e.id];
    // The CMS pushes an event only while one of its switches is on, so an
    // event that is off in both has nothing for any tag — Ads included — to fire on.
    if (!sw?.ga4 && !sw?.meta) continue;
    out.push({
      id: e.id,
      name: e.ga4,
      params: [...e.params],
      ga4: Boolean(sw?.ga4),
      meta: sw?.meta && e.meta ? { name: e.meta.name, method: e.meta.standard ? 'track' : 'trackCustom' } : null,
      ...(e.ga4 === 'sign_up' && e.fixed?.method ? { method: e.fixed.method } : {}),
    });
  }
  for (const c of input.customEvents) {
    if (!c.ga4 && !c.meta) continue;
    out.push({
      id: c.name,
      name: c.name,
      params: [...TRIGGER_PARAMS[c.trigger.type], ...c.params.map((p) => p.key)],
      ga4: c.ga4,
      meta: c.meta ? { name: c.name, method: 'trackCustom' } : null,
    });
  }
  return out;
}

export function buildGtmContainer(input: GtmExportInput): GtmContainerExport {
  const events = exportEvents(input);
  const withGa4 = input.ga4ViaGtm;
  const withMeta = input.pixelViaGtm && Boolean(input.pixelId);
  const adsId = input.googleAds.conversionId ?? null;

  // ── Variables ──────────────────────────────────────────────────────────
  const variables: Variable[] = [];
  const addDlv = (name: string, dataLayerKey: string) => {
    if (variables.some((v) => v.name === PREFIX + name)) return;
    variables.push({
      ...ids,
      variableId: String(variables.length + 1),
      name: PREFIX + name,
      type: 'v',
      parameter: [
        { type: 'INTEGER', key: 'dataLayerVersion', value: '2' },
        bool('setDefaultValue', false),
        tpl('name', dataLayerKey),
      ],
    });
  };
  if (withGa4) addDlv(dlvName('cms_ga4_id'), 'cms_ga4_id');
  if (withMeta) {
    addDlv('Pixel ID', 'cms_meta_pixel_id');
    addDlv(dlvName('cms_meta.params'), 'cms_meta.params');
  }
  addDlv(dlvName('event_id'), 'event_id');
  addDlv(dlvName('method'), 'method');
  for (const p of COMMON_EVENT_PARAMS) addDlv(dlvName(p), p);
  for (const e of events) for (const p of e.params) addDlv(dlvName(p), p);
  if (adsId) for (const p of ['value', 'currency', 'transaction_id']) addDlv(dlvName(p), p);

  // ── Triggers ───────────────────────────────────────────────────────────
  const triggers: Trigger[] = [];
  const triggerFor = new Map<string, string>();
  for (const e of events) {
    const triggerId = String(triggers.length + 1);
    triggers.push({
      ...ids,
      triggerId,
      name: `${PREFIX}Trigger · ${e.id}`,
      type: 'CUSTOM_EVENT',
      customEventFilter: [equals('{{_event}}', e.name)],
      ...(e.method ? { filter: [equals(ref(dlvName('method')), e.method)] } : {}),
    });
    triggerFor.set(e.id, triggerId);
  }

  // ── Tags ───────────────────────────────────────────────────────────────
  const tags: Tag[] = [];
  const addTag = (tag: Omit<Tag, 'tagId' | 'accountId' | 'containerId' | 'tagFiringOption'>) =>
    tags.push({ ...ids, tagId: String(tags.length + 1), tagFiringOption: 'ONCE_PER_EVENT', ...tag });

  if (withGa4) {
    addTag({
      name: `${PREFIX}Google tag`,
      type: 'googtag',
      parameter: [
        tpl('tagId', ref(dlvName('cms_ga4_id'))),
        {
          type: 'LIST',
          key: 'configSettingsTable',
          // The CMS pushes `page_view` itself, entry and SPA changes alike.
          list: [{ type: 'MAP', map: [tpl('parameter', 'send_page_view'), tpl('parameterValue', 'false')] }],
        },
      ],
      firingTriggerId: [INITIALIZATION_ALL_PAGES],
      consentSettings: consent('analytics_storage'),
    });
    for (const e of events.filter((x) => x.ga4)) {
      const params = [...COMMON_EVENT_PARAMS, ...e.params];
      addTag({
        name: `${PREFIX}GA4 · ${e.id}`,
        type: 'gaawe',
        parameter: [
          tpl('eventName', e.name),
          tpl('measurementIdOverride', ref(dlvName('cms_ga4_id'))),
          {
            type: 'LIST',
            key: 'eventSettingsTable',
            list: [...new Set(params)].map((p) => ({
              type: 'MAP',
              map: [tpl('parameter', p), tpl('parameterValue', ref(dlvName(p)))],
            })),
          },
        ],
        firingTriggerId: [triggerFor.get(e.id) ?? ''],
        consentSettings: consent('analytics_storage'),
      });
    }
  }

  if (withMeta) {
    const seen = new Set<string>();
    for (const e of events) {
      if (!e.meta) continue;
      // Two events can share a Meta name (Lead, Contact): the first keeps it bare.
      const name = seen.has(e.meta.name) ? `${PREFIX}Meta · ${e.meta.name} · ${e.id}` : `${PREFIX}Meta · ${e.meta.name}`;
      seen.add(e.meta.name);
      addTag({
        name,
        type: `cvt_${TEMPLATE_ID}`,
        parameter: [
          tpl('pixelId', ref('Pixel ID')),
          tpl('method', e.meta.method),
          tpl('eventName', e.meta.name),
          tpl('eventParams', ref(dlvName('cms_meta.params'))),
          tpl('eventId', ref(dlvName('event_id'))),
        ],
        firingTriggerId: [triggerFor.get(e.id) ?? ''],
        consentSettings: consent('ad_storage'),
      });
    }
  }

  if (adsId) {
    const labelled = events.filter((e) => input.googleAds.labels[e.id]);
    if (labelled.length > 0) {
      addTag({
        name: `${PREFIX}Ads · Conversion Linker`,
        type: 'gclidw',
        parameter: [bool('enableCrossDomain', false), bool('enableUrlPassthrough', false)],
        firingTriggerId: [ALL_PAGES],
        consentSettings: consent('ad_storage'),
      });
    }
    for (const e of labelled) {
      addTag({
        name: `${PREFIX}Ads · ${e.id}`,
        type: 'awct',
        parameter: [
          tpl('conversionId', adsId.replace(/^AW-/, '')),
          tpl('conversionLabel', input.googleAds.labels[e.id]),
          tpl('conversionValue', ref(dlvName('value'))),
          tpl('currencyCode', ref(dlvName('currency'))),
          tpl('orderId', ref(dlvName('transaction_id'))),
          bool('enableConversionLinker', true),
        ],
        firingTriggerId: [triggerFor.get(e.id) ?? ''],
        consentSettings: consent('ad_storage'),
      });
    }
  }

  return {
    exportFormatVersion: 2,
    exportTime: input.exportTime.toISOString().replace('T', ' ').slice(0, 19),
    containerVersion: {
      path: 'accounts/0/containers/0/versions/0',
      ...ids,
      containerVersionId: '0',
      container: {
        path: 'accounts/0/containers/0',
        ...ids,
        name: `${PREFIX}${input.gtmId}`,
        publicId: input.gtmId,
        usageContext: ['WEB'],
      },
      tag: tags,
      trigger: triggers,
      variable: variables,
      builtInVariable: [{ ...ids, type: 'EVENT', name: 'Event' }],
      customTemplate: withMeta
        ? [{ ...ids, templateId: TEMPLATE_ID, name: `${PREFIX}Meta Pixel`, templateData: META_TEMPLATE }]
        : [],
    },
  };
}

/** Every CMS-owned entity name in an export, for the next export's comparison. */
export function gtmEntityNames(container: GtmContainerExport): string[] {
  const cv = container.containerVersion as { tag?: { name: string }[]; trigger?: { name: string }[]; variable?: { name: string }[] };
  return [...(cv.tag ?? []), ...(cv.trigger ?? []), ...(cv.variable ?? [])].map((e) => e.name).filter((n) => n.startsWith(PREFIX));
}

/** In the last download, not in this one: an import never deletes, so these go by hand. */
export function staleGtmEntities(previous: readonly string[], current: readonly string[]): string[] {
  const now = new Set(current);
  return previous.filter((n) => n.startsWith(PREFIX) && !now.has(n));
}

/**
 * The "CMS · Meta Pixel" tag template (sandboxed JS), carried in the export.
 * Loads fbevents.js, initialises the Pixel once, sends one event — standard
 * (`track`) or custom (`trackCustom`) — with the parameters the CMS already
 * mapped and the event id it shares with the Conversions API.
 */
const META_TEMPLATE = [
  '___TERMS_OF_SERVICE___',
  '',
  "By creating or modifying this file you agree to Google Tag Manager's Community",
  'Template Gallery Developer Terms of Service available at',
  'https://developers.google.com/tag-manager/gallery-tos (or such other URL as',
  'Google may provide), as modified from time to time.',
  '',
  '',
  '___INFO___',
  '',
  JSON.stringify(
    {
      type: 'TAG',
      id: 'cvt_temp_public_id',
      version: 1,
      securityGroups: [],
      displayName: 'CMS · Meta Pixel',
      categories: ['ADVERTISING', 'ANALYTICS'],
      brand: { id: 'brand_dummy', displayName: '' },
      description:
        'Generated by the CMS. Sends one Meta Pixel event from the CMS dataLayer. Do not edit: the next import overwrites it.',
      containerContexts: ['WEB'],
    },
    null,
    2,
  ),
  '',
  '',
  '___TEMPLATE_PARAMETERS___',
  '',
  JSON.stringify(
    [
      { type: 'TEXT', name: 'pixelId', displayName: 'Pixel ID', simpleValueType: true, valueValidators: [{ type: 'NON_EMPTY' }] },
      {
        type: 'SELECT',
        name: 'method',
        displayName: 'Method',
        macrosInSelect: false,
        selectItems: [
          { value: 'track', displayValue: 'track (standard event)' },
          { value: 'trackCustom', displayValue: 'trackCustom (custom event)' },
        ],
        simpleValueType: true,
      },
      { type: 'TEXT', name: 'eventName', displayName: 'Event name', simpleValueType: true, valueValidators: [{ type: 'NON_EMPTY' }] },
      { type: 'TEXT', name: 'eventParams', displayName: 'Parameters (object variable)', simpleValueType: true },
      { type: 'TEXT', name: 'eventId', displayName: 'Event ID (dedup with the Conversions API)', simpleValueType: true },
    ],
    null,
    2,
  ),
  '',
  '',
  '___SANDBOXED_JS_FOR_WEB_TEMPLATE___',
  '',
  [
    "const injectScript = require('injectScript');",
    "const copyFromWindow = require('copyFromWindow');",
    "const setInWindow = require('setInWindow');",
    "const callInWindow = require('callInWindow');",
    "const createQueue = require('createQueue');",
    "const aliasInWindow = require('aliasInWindow');",
    "const getType = require('getType');",
    '',
    'const getFbq = () => {',
    "  const existing = copyFromWindow('fbq');",
    '  if (existing) return existing;',
    "  setInWindow('fbq', function() {",
    "    const callMethod = copyFromWindow('fbq.callMethod.apply');",
    '    if (callMethod) {',
    "      callInWindow('fbq.callMethod.apply', null, arguments);",
    '    } else {',
    "      callInWindow('fbq.queue.push', arguments);",
    '    }',
    '  });',
    "  aliasInWindow('_fbq', 'fbq');",
    "  createQueue('fbq.queue');",
    "  return copyFromWindow('fbq');",
    '};',
    '',
    'const fbq = getFbq();',
    "const initialised = copyFromWindow('_cms_fbq_ids') || [];",
    'if (initialised.indexOf(data.pixelId) === -1) {',
    "  fbq('consent', 'grant');",
    "  fbq('init', data.pixelId);",
    '  initialised.push(data.pixelId);',
    "  setInWindow('_cms_fbq_ids', initialised, true);",
    '}',
    "const params = getType(data.eventParams) === 'object' ? data.eventParams : {};",
    "const options = data.eventId ? { eventID: data.eventId } : {};",
    "fbq(data.method === 'trackCustom' ? 'trackCustom' : 'track', data.eventName, params, options);",
    "injectScript('https://connect.facebook.net/en_US/fbevents.js', data.gtmOnSuccess, data.gtmOnFailure, 'fbPixel');",
  ].join('\n'),
  '',
  '',
  '___WEB_PERMISSIONS___',
  '',
  JSON.stringify(
    [
      {
        instance: {
          key: { publicId: 'access_globals', versionId: '1' },
          param: [
            {
              key: 'keys',
              value: {
                type: 2,
                listItem: [
                  ['fbq', true, true, true],
                  ['_fbq', true, true, false],
                  ['fbq.callMethod.apply', true, false, true],
                  ['fbq.queue.push', false, false, true],
                  ['fbq.queue', true, true, false],
                  ['_cms_fbq_ids', true, true, false],
                ].map(([key, read, write, execute]) => ({
                  type: 3,
                  mapKey: ['key', 'read', 'write', 'execute'].map((string) => ({ type: 1, string })),
                  mapValue: [
                    { type: 1, string: key },
                    { type: 8, boolean: read },
                    { type: 8, boolean: write },
                    { type: 8, boolean: execute },
                  ],
                })),
              },
            },
          ],
        },
        clientAnnotations: { isEditedByUser: true },
        isRequired: true,
      },
      {
        instance: {
          key: { publicId: 'inject_script', versionId: '1' },
          param: [{ key: 'urls', value: { type: 2, listItem: [{ type: 1, string: 'https://connect.facebook.net/*' }] } }],
        },
        clientAnnotations: { isEditedByUser: true },
        isRequired: true,
      },
    ],
    null,
    2,
  ),
  '',
  '',
  '___TESTS___',
  '',
  'scenarios: []',
  '',
  '',
  '___NOTES___',
  '',
  'Generated by the CMS (Settings → Analytics & Marketing → GTM export).',
  '',
].join('\n');
