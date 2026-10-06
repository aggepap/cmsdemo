/**
 * The catalogue a site starts with, and the entry that describes Google
 * Analytics.
 *
 * Two readers share this file on purpose. `seedCookieCatalog` writes the
 * categories into an empty database, and `withAnalyticsDeclaration` synthesizes
 * the analytics category when an admin has deleted it but still has a
 * measurement ID configured. If those two disagreed about what "analytics"
 * means, a visitor's stored consent for one would not apply to the other.
 *
 * No `server-only` here, and nothing site-specific: `AnalyticsLoader` (a client
 * component) reads `ANALYTICS_CATEGORY_KEY` from this module, and the CMS core
 * must stay extractable.
 */

/** Per-locale copy. The site's two locales are named so a missing one is a type
 *  error, and the index signature keeps it assignable to the column type. */
export interface LocaleText {
  el: string;
  en: string;
  [locale: string]: string;
}

export interface DefaultCookieService {
  name: string;
  provider: string | null;
  purpose: LocaleText;
}

export interface DefaultCookieCategory {
  key: string;
  name: LocaleText;
  description: LocaleText;
  required: boolean;
  sortOrder: number;
  services: readonly DefaultCookieService[];
}

/**
 * The category key GA is asked about. A cookie category with this key is what
 * makes analytics separately refusable; without one, `useCategoryConsent` falls
 * back to the blanket consent flag and GA rides in on any acceptance.
 */
export const ANALYTICS_CATEGORY_KEY = 'analytics';

/**
 * Google Analytics as it appears in the declaration.
 *
 * Not seeded — a site with no measurement ID must not claim to run GA. It is
 * added to the declaration only when an ID actually resolves.
 */
export const GOOGLE_ANALYTICS_SERVICE: DefaultCookieService = {
  name: 'Google Analytics 4',
  provider: 'Google',
  purpose: {
    el: 'Μετρά επισκέψεις και προβολές σελίδων ανώνυμα (η διεύθυνση IP ανωνυμοποιείται), ώστε να καταλαβαίνουμε πώς χρησιμοποιείται ο ιστότοπος. Cookies: _ga, _ga_*, _gid.',
    en: 'Counts visits and page views anonymously (the IP address is anonymised) so we can understand how the site is used. Cookies: _ga, _ga_*, _gid.',
  },
};

/** The category advertising and remarketing tags are asked about. */
export const MARKETING_CATEGORY_KEY = 'marketing';

/**
 * The Meta Pixel as it appears in the declaration — added only while a Pixel ID
 * is set (Settings → Analytics & Marketing), directly or through GTM.
 */
export const META_PIXEL_SERVICE: DefaultCookieService = {
  name: 'Meta Pixel',
  provider: 'Meta',
  purpose: {
    el: 'Μετρά την απόδοση των διαφημίσεών μας στο Facebook και στο Instagram και μας επιτρέπει να σας δείχνουμε σχετικές διαφημίσεις. Με τη συγκατάθεσή σας, κρυπτογραφημένα (hashed) στοιχεία επικοινωνίας από μια παραγγελία ή φόρμα αποστέλλονται επίσης στη Meta από τον διακομιστή μας. Cookies: _fbp, _fbc.',
    en: 'Measures how our ads on Facebook and Instagram perform and lets us show you relevant ads. With your consent, hashed contact details from an order or form are also sent to Meta from our server. Cookies: _fbp, _fbc.',
  },
};

/** The category the site cannot work without. */
export const NECESSARY_CATEGORY_KEY = 'necessary';

/**
 * Google reCAPTCHA on the public forms, as it appears in the declaration.
 *
 * Necessary, not marketing or analytics: it is a security measure, and the form
 * cannot be sent without it. Declared only while the captcha is switched on for
 * the public forms (Settings → Security), like GA only while an ID is set.
 */
export const GOOGLE_RECAPTCHA_SERVICE: DefaultCookieService = {
  name: 'Google reCAPTCHA',
  provider: 'Google',
  purpose: {
    el: 'Για την ασφάλεια των φορμών: ελέγχει ότι η υποβολή γίνεται από άνθρωπο και όχι από αυτόματο πρόγραμμα (bot). Φορτώνει μόνο όταν αρχίσετε να συμπληρώνετε μια φόρμα.',
    en: 'For form security: checks that a submission comes from a person and not an automated program (bot). It loads only when you start filling in a form.',
  },
};

/**
 * Google Ads conversion tracking, as it appears in the declaration — added only
 * while a Google Ads conversion ID is set and a GTM container carries the tags.
 */
export const GOOGLE_ADS_SERVICE: DefaultCookieService = {
  name: 'Google Ads',
  provider: 'Google',
  purpose: {
    el: 'Μετρά ποιες επισκέψεις από διαφημίσεις μας στη Google καταλήγουν σε αίτημα ή αγορά, ώστε να ξέρουμε ποιες διαφημίσεις αποδίδουν. Cookies: _gcl_*.',
    en: 'Measures which visits from our Google ads lead to an enquiry or a purchase, so we know which ads work. Cookies: _gcl_*.',
  },
};

export const DEFAULT_COOKIE_CATEGORIES: readonly DefaultCookieCategory[] = [
  {
    key: NECESSARY_CATEGORY_KEY,
    name: { el: 'Απαραίτητα', en: 'Necessary' },
    description: {
      el: 'Χωρίς αυτά ο ιστότοπος δεν λειτουργεί: θυμούνται τη συνεδρία σας, το καλάθι σας και την ίδια σας την επιλογή για τα cookies. Δεν χρησιμοποιούνται για παρακολούθηση και δεν απενεργοποιούνται.',
      en: 'The site does not work without these: they remember your session, your basket, and your cookie choice itself. They are not used for tracking and cannot be switched off.',
    },
    required: true,
    sortOrder: 0,
    services: [
      {
        // Deliberately generic: the column is a single string with no locale
        // map, and this file is part of the reusable core.
        name: 'Session & consent',
        provider: null,
        purpose: {
          el: 'Κρατά τη συνεδρία σύνδεσης, το καλάθι αγορών και την καταγραφή της επιλογής σας για τα cookies.',
          en: 'Keeps the login session, the shopping basket, and the record of your cookie choice.',
        },
      },
    ],
  },
  {
    key: ANALYTICS_CATEGORY_KEY,
    name: { el: 'Στατιστικά', en: 'Analytics' },
    description: {
      el: 'Μας δείχνουν πώς χρησιμοποιείται ο ιστότοπος — ποιες σελίδες διαβάζονται και από πού έρχονται οι επισκέπτες — ώστε να τον βελτιώνουμε. Αν τα απορρίψετε, ο ιστότοπος λειτουργεί κανονικά.',
      en: 'They show us how the site is used — which pages are read, and where visitors arrive from — so we can improve it. Refusing them changes nothing about how the site works.',
    },
    required: false,
    sortOrder: 1,
    services: [],
  },
  {
    key: MARKETING_CATEGORY_KEY,
    name: { el: 'Μάρκετινγκ', en: 'Marketing' },
    description: {
      el: 'Χρησιμοποιούνται για να σας εμφανίζονται σχετικές διαφημίσεις σε άλλους ιστότοπους και για να μετράται η απόδοσή τους.',
      en: 'Used to show you relevant advertising on other sites, and to measure how it performs.',
    },
    required: false,
    sortOrder: 2,
    services: [],
  },
];

/** What the site runs, for the catalogue it is seeded with. Omitted = on. */
export interface CookieCatalogOptions {
  /** A shop: customer login and a basket, both kept in cookies. */
  shop?: boolean;
  /** Advertising or remarketing scripts, which need a Marketing category. */
  marketing?: boolean;
}

/**
 * The necessary category for a site with no shop. The default copy promises a
 * login session and a basket, which such a site does not have, and its privacy
 * page then contradicted the cookie declaration (F-008).
 */
const NECESSARY_WITHOUT_SHOP: Pick<DefaultCookieCategory, 'description' | 'services'> = {
  description: {
    el: 'Χωρίς αυτά ο ιστότοπος δεν λειτουργεί: θυμούνται την επιλογή σας για τα cookies. Δεν χρησιμοποιούνται για παρακολούθηση και δεν απενεργοποιούνται.',
    en: 'The site does not work without these: they remember your cookie choice. They are not used for tracking and cannot be switched off.',
  },
  services: [
    {
      name: 'Consent',
      provider: null,
      purpose: {
        el: 'Κρατά την καταγραφή της επιλογής σας για τα cookies.',
        en: 'Keeps the record of your cookie choice.',
      },
    },
  ],
};

/** The catalogue to seed for a site that runs what `options` says. */
export function defaultCookieCategories(
  options: CookieCatalogOptions
): readonly DefaultCookieCategory[] {
  if (options.shop !== false && options.marketing !== false) return DEFAULT_COOKIE_CATEGORIES;
  return DEFAULT_COOKIE_CATEGORIES.filter(
    (c) => options.marketing !== false || c.key !== 'marketing'
  ).map((c) =>
    c.key === 'necessary' && options.shop === false ? { ...c, ...NECESSARY_WITHOUT_SHOP } : c
  );
}

/** The default definition of a category, by key. */
export function defaultCategory(key: string): DefaultCookieCategory | undefined {
  return DEFAULT_COOKIE_CATEGORIES.find((c) => c.key === key);
}
