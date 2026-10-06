/*
 * Manual QA checklists — shared behaviour.
 *
 * Each page marks up test cases as <article class="tc" id="XX-000" data-priority="P1|P2|P3">.
 * This script adds Pass / Fail / Blocked / N/A buttons and a notes box to every case,
 * a sticky toolbar with progress, filters and export, and tester details at the top.
 * Results live in this browser's localStorage only; export to share them.
 */
(function () {
  'use strict';

  /*
   * Greek pages live in el/ with the same file names and <html lang="el">. Both languages
   * share one set of results per checklist, since the case IDs are identical.
   */
  var LANG = document.documentElement.lang === 'el' ? 'el' : 'en';
  var I18N = {
    en: {
      pages: [
        'Setup, install & configuration',
        'Database schema & migrations',
        'Content: collections, documents, publishing',
        'Admin UI & navigation',
        'Authentication, users, roles & security',
        'Media, SEO & structured data',
        'Forms, email, newsletter, popups, cookies',
        'Commerce: shop, checkout, orders',
        'Booking: availability & reservations',
        'Settings, scheduled jobs & operations',
        'Public site, languages, accessibility & performance',
        'Site transfer: export & import',
      ],
      status: { pass: 'Pass', fail: 'Fail', blocked: 'Blocked', na: 'N/A' },
      meta: { tester: 'Tester', env: 'Environment URL', build: 'Build / commit', date: 'Test date' },
      cols: ['Checklist', 'Cases', 'Run', 'Pass', 'Fail', 'Blocked'],
      indexNote: 'Counts come from this browser. "Cases" appears once a checklist has been opened here.',
      indexNoStorage: 'This browser is blocking local storage, so results cannot be saved or totalled. Use Export on each page.',
      resultFor: 'Result for ',
      notesFor: 'Notes for ',
      notesPh: 'Notes, defect ID, screenshot link…',
      searchPh: 'Filter by text or ID',
      searchLabel: 'Filter test cases',
      byResult: 'Filter by result',
      allResults: 'All results',
      notRun: 'Not run',
      byPriority: 'Filter by priority',
      allPriorities: 'All priorities',
      p1: 'P1 — smoke',
      p2: 'P2 — core',
      p3: 'P3 — edge',
      csv: 'Export CSV',
      json: 'Export JSON',
      reset: 'Reset page',
      resetConfirm: 'Clear every result and note on this page?',
      counts: function (run, total, c) {
        return run + ' of ' + total + ' run · ' + c.pass + ' pass · ' + c.fail + ' fail · ' + c.blocked + ' blocked · ' + c.na + ' N/A';
      },
      other: 'Ελληνικά',
    },
    el: {
      pages: [
        'Εγκατάσταση & ρυθμίσεις',
        'Σχήμα βάσης δεδομένων & migrations',
        'Περιεχόμενο: συλλογές, έγγραφα, δημοσίευση',
        'Διαχειριστικό & πλοήγηση',
        'Σύνδεση, χρήστες, ρόλοι & ασφάλεια',
        'Πολυμέσα, SEO & δομημένα δεδομένα',
        'Φόρμες, email, newsletter, popups, cookies',
        'Ηλεκτρονικό κατάστημα: παραγγελίες & πληρωμές',
        'Κρατήσεις: διαθεσιμότητα & κρατήσεις',
        'Ρυθμίσεις, προγραμματισμένες εργασίες & λειτουργία',
        'Δημόσιος ιστότοπος, γλώσσες, προσβασιμότητα & απόδοση',
        'Μεταφορά δεδομένων: εξαγωγή & εισαγωγή',
      ],
      status: { pass: 'Επιτυχία', fail: 'Αποτυχία', blocked: 'Μπλοκαρισμένο', na: 'Δεν ισχύει' },
      meta: { tester: 'Ελεγκτής', env: 'URL περιβάλλοντος', build: 'Έκδοση / commit', date: 'Ημερομηνία ελέγχου' },
      cols: ['Λίστα ελέγχου', 'Περιπτώσεις', 'Εκτελέστηκαν', 'Επιτυχία', 'Αποτυχία', 'Μπλοκαρισμένες'],
      indexNote: 'Οι αριθμοί προέρχονται από αυτόν τον browser. Οι «Περιπτώσεις» εμφανίζονται μόλις ανοίξει εδώ μια λίστα ελέγχου.',
      indexNoStorage: 'Αυτός ο browser μπλοκάρει την τοπική αποθήκευση, οπότε τα αποτελέσματα δεν αποθηκεύονται ούτε αθροίζονται. Χρησιμοποιήστε την Εξαγωγή σε κάθε σελίδα.',
      resultFor: 'Αποτέλεσμα για ',
      notesFor: 'Σημειώσεις για ',
      notesPh: 'Σημειώσεις, αριθμός σφάλματος, σύνδεσμος στιγμιότυπου…',
      searchPh: 'Φιλτράρισμα με κείμενο ή ID',
      searchLabel: 'Φιλτράρισμα περιπτώσεων ελέγχου',
      byResult: 'Φιλτράρισμα κατά αποτέλεσμα',
      allResults: 'Όλα τα αποτελέσματα',
      notRun: 'Δεν εκτελέστηκε',
      byPriority: 'Φιλτράρισμα κατά προτεραιότητα',
      allPriorities: 'Όλες οι προτεραιότητες',
      p1: 'P1 — βασικός έλεγχος (smoke)',
      p2: 'P2 — κύρια λειτουργία',
      p3: 'P3 — οριακές περιπτώσεις',
      csv: 'Εξαγωγή CSV',
      json: 'Εξαγωγή JSON',
      reset: 'Επαναφορά σελίδας',
      resetConfirm: 'Να διαγραφούν όλα τα αποτελέσματα και οι σημειώσεις αυτής της σελίδας;',
      counts: function (run, total, c) {
        return run + ' από ' + total + ' εκτελέστηκαν · ' + c.pass + ' επιτυχία · ' + c.fail + ' αποτυχία · ' + c.blocked + ' μπλοκαρισμένες · ' + c.na + ' δεν ισχύει';
      },
      other: 'English',
    },
  };
  var T = I18N[LANG];
  var FILES = [
    '01-setup.html',
    '02-database-schema.html',
    '03-content.html',
    '04-admin-ui.html',
    '05-auth-security.html',
    '06-media-seo.html',
    '07-forms-email-marketing.html',
    '08-commerce.html',
    '09-booking.html',
    '10-settings-cron-ops.html',
    '11-public-site.html',
    '12-site-transfer.html',
  ];
  var PAGES = FILES.map(function (f, i) {
    return [f, T.pages[i]];
  });
  var STATUSES = ['pass', 'fail', 'blocked', 'na'].map(function (k) {
    return [k, T.status[k]];
  });

  function store() {
    try {
      var k = '__qa_probe__';
      window.localStorage.setItem(k, '1');
      window.localStorage.removeItem(k);
      return window.localStorage;
    } catch {
      return null;
    }
  }
  var ls = store();
  function get(key, fallback) {
    if (!ls) return fallback;
    try {
      var v = ls.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  }
  function set(key, value) {
    if (!ls) return;
    try {
      ls.setItem(key, JSON.stringify(value));
    } catch {
      /* storage full or blocked — results just won't persist */
    }
  }

  var page = (location.pathname.split('/').pop() || 'index.html').replace(/\.html$/, '');
  var resultKey = 'qa:results:' + page;
  var totalKey = 'qa:total:' + page;
  var metaKey = 'qa:meta';

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (a) {
        if (a === 'text') n.textContent = attrs[a];
        else n.setAttribute(a, attrs[a]);
      });
    }
    (children || []).forEach(function (c) {
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }

  function download(name, type, body) {
    var blob = new Blob([body], { type: type });
    var a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 0);
  }

  function csvCell(v) {
    var s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /* ---------- Tester details (shared across pages) ---------- */
  function metaPanel() {
    var meta = get(metaKey, {});
    var fields = ['tester', 'env', 'build', 'date'].map(function (k) {
      return [k, T.meta[k]];
    });
    var wrap = el('div', { class: 'qa-meta' });
    fields.forEach(function (f) {
      var input = el('input', { type: f[0] === 'date' ? 'date' : 'text', value: meta[f[0]] || '' });
      input.addEventListener('input', function () {
        meta[f[0]] = input.value;
        set(metaKey, meta);
      });
      wrap.appendChild(el('label', null, [f[1], input]));
    });
    return wrap;
  }

  /* ---------- Index page: progress across all pages ---------- */
  function renderIndex() {
    var host = document.getElementById('qa-index');
    if (!host) return;
    var rows = PAGES.map(function (p) {
      var id = p[0].replace(/\.html$/, '');
      var res = get('qa:results:' + id, {});
      var total = get('qa:total:' + id, null);
      var c = { pass: 0, fail: 0, blocked: 0, na: 0 };
      Object.keys(res).forEach(function (k) {
        if (res[k] && c[res[k].status] !== undefined) c[res[k].status]++;
      });
      var done = c.pass + c.fail + c.blocked + c.na;
      return el('tr', null, [
        el('td', null, [el('a', { href: p[0], text: p[1] })]),
        el('td', { text: total == null ? '—' : String(total) }),
        el('td', { text: String(done) }),
        el('td', { text: String(c.pass) }),
        el('td', { text: String(c.fail) }),
        el('td', { text: String(c.blocked) }),
      ]);
    });
    var table = el('table', null, [
      el('thead', null, [
        el('tr', null, T.cols.map(function (h) {
          return el('th', { text: h });
        })),
      ]),
      el('tbody', null, rows),
    ]);
    host.appendChild(el('div', { class: 'table-wrap' }, [table]));
    var note = el('p', {
      class: 'note',
      text: ls ? T.indexNote : T.indexNoStorage,
    });
    host.appendChild(note);
    var header = document.querySelector('header.page');
    if (header) header.appendChild(metaPanel());
  }

  /* ---------- Checklist pages ---------- */
  function renderChecklist(cases) {
    var results = get(resultKey, {});
    set(totalKey, cases.length);

    function save() {
      set(resultKey, results);
      refresh();
    }

    cases.forEach(function (tc) {
      var id = tc.id;
      var h3 = tc.querySelector('h3');
      if (h3 && !h3.querySelector('.tc-id')) {
        h3.insertBefore(el('span', { class: 'tc-id', text: id }), h3.firstChild);
        var prio = tc.getAttribute('data-priority');
        if (prio) h3.appendChild(el('span', { class: 'tc-prio ' + prio, text: prio }));
      }
      var r = results[id] || {};
      var controls = el('div', { class: 'tc-controls', role: 'group', 'aria-label': T.resultFor + id });
      var buttons = STATUSES.map(function (s) {
        var b = el('button', { type: 'button', class: 'st ' + s[0], 'aria-pressed': String(r.status === s[0]), text: s[1] });
        b.addEventListener('click', function () {
          var cur = results[id] || {};
          cur.status = cur.status === s[0] ? undefined : s[0];
          cur.at = new Date().toISOString();
          results[id] = cur;
          buttons.forEach(function (x, i) {
            x.setAttribute('aria-pressed', String(cur.status === STATUSES[i][0]));
          });
          if (cur.status) tc.setAttribute('data-status', cur.status);
          else tc.removeAttribute('data-status');
          save();
        });
        controls.appendChild(b);
        return b;
      });
      var notes = el('textarea', { rows: '1', placeholder: T.notesPh, 'aria-label': T.notesFor + id });
      notes.value = r.notes || '';
      notes.addEventListener('input', function () {
        var cur = results[id] || {};
        cur.notes = notes.value;
        results[id] = cur;
        set(resultKey, results);
      });
      controls.appendChild(notes);
      tc.appendChild(controls);
      if (r.status) tc.setAttribute('data-status', r.status);
    });

    /* Toolbar */
    var bar = el('div', { class: 'qa-bar' });
    var counts = el('div', { class: 'qa-counts' });
    var search = el('input', { type: 'search', placeholder: T.searchPh, 'aria-label': T.searchLabel });
    var statusSel = el('select', { 'aria-label': T.byResult }, [
      el('option', { value: '', text: T.allResults }),
      el('option', { value: 'todo', text: T.notRun }),
      el('option', { value: 'pass', text: T.status.pass }),
      el('option', { value: 'fail', text: T.status.fail }),
      el('option', { value: 'blocked', text: T.status.blocked }),
      el('option', { value: 'na', text: T.status.na }),
    ]);
    var prioSel = el('select', { 'aria-label': T.byPriority }, [
      el('option', { value: '', text: T.allPriorities }),
      el('option', { value: 'P1', text: T.p1 }),
      el('option', { value: 'P2', text: T.p2 }),
      el('option', { value: 'P3', text: T.p3 }),
    ]);
    var csvBtn = el('button', { type: 'button', text: T.csv });
    var jsonBtn = el('button', { type: 'button', text: T.json });
    var resetBtn = el('button', { type: 'button', text: T.reset });

    var toolbar = el('div', { class: 'qa-toolbar' }, [
      el('div', { class: 'row' }, [el('div', { class: 'qa-progress' }, [bar, counts])]),
      el('div', { class: 'row' }, [search, statusSel, prioSel, csvBtn, jsonBtn, resetBtn]),
    ]);
    var header = document.querySelector('header.page');
    header.appendChild(metaPanel());
    header.parentNode.insertBefore(toolbar, header.nextSibling);

    function applyFilters() {
      var q = search.value.trim().toLowerCase();
      var st = statusSel.value;
      var pr = prioSel.value;
      cases.forEach(function (tc) {
        var r = results[tc.id] || {};
        var show = true;
        if (q && tc.textContent.toLowerCase().indexOf(q) === -1) show = false;
        if (st === 'todo' && r.status) show = false;
        if (st && st !== 'todo' && r.status !== st) show = false;
        if (pr && tc.getAttribute('data-priority') !== pr) show = false;
        tc.classList.toggle('hidden', !show);
      });
      document.querySelectorAll('section.suite').forEach(function (s) {
        var any = s.querySelector('article.tc:not(.hidden)');
        s.classList.toggle('hidden', !any);
      });
    }
    [search, statusSel, prioSel].forEach(function (c) {
      c.addEventListener('input', applyFilters);
    });

    function refresh() {
      var c = { pass: 0, fail: 0, blocked: 0, na: 0 };
      cases.forEach(function (tc) {
        var s = (results[tc.id] || {}).status;
        if (s) c[s]++;
      });
      var total = cases.length || 1;
      bar.textContent = '';
      [['p', c.pass], ['f', c.fail], ['b', c.blocked], ['n', c.na]].forEach(function (x) {
        if (x[1]) bar.appendChild(el('span', { class: x[0], style: 'width:' + (100 * x[1]) / total + '%' }));
      });
      var run = c.pass + c.fail + c.blocked + c.na;
      counts.textContent = T.counts(run, cases.length, c);
      applyFilters();
    }

    function rows() {
      var meta = get(metaKey, {});
      return cases.map(function (tc) {
        var r = results[tc.id] || {};
        var h = tc.querySelector('h3');
        var title = h ? h.textContent.replace(tc.id, '').replace(/P[123]$/, '').trim() : '';
        var suite = tc.closest('section.suite');
        var suiteTitle = suite && suite.querySelector('h2') ? suite.querySelector('h2').textContent.trim() : '';
        return {
          page: page,
          suite: suiteTitle,
          id: tc.id,
          priority: tc.getAttribute('data-priority') || '',
          title: title,
          status: r.status || 'not run',
          notes: r.notes || '',
          updated: r.at || '',
          tester: meta.tester || '',
          environment: meta.env || '',
          build: meta.build || '',
        };
      });
    }
    csvBtn.addEventListener('click', function () {
      var data = rows();
      var cols = Object.keys(data[0] || { id: '' });
      var body = [cols.join(',')].concat(data.map(function (r) {
        return cols.map(function (c) { return csvCell(r[c]); }).join(',');
      })).join('\n');
      download('qa-' + page + '.csv', 'text/csv', body);
    });
    jsonBtn.addEventListener('click', function () {
      download('qa-' + page + '.json', 'application/json', JSON.stringify({ meta: get(metaKey, {}), results: rows() }, null, 2));
    });
    resetBtn.addEventListener('click', function () {
      if (!window.confirm(T.resetConfirm)) return;
      results = {};
      set(resultKey, results);
      location.reload();
    });

    refresh();
  }

  /* Link to the same page in the other language, added to the breadcrumb bar. */
  function languageLink() {
    var file = location.pathname.split('/').pop() || 'index.html';
    var href = LANG === 'el' ? '../' + file : 'el/' + file;
    var link = el('a', { href: href, hreflang: LANG === 'el' ? 'en' : 'el', lang: LANG === 'el' ? 'en' : 'el', class: 'lang-switch', text: T.other });
    var crumbs = document.querySelector('nav.crumbs');
    if (crumbs) {
      crumbs.appendChild(link);
    } else {
      var header = document.querySelector('header.page');
      if (header) header.insertBefore(el('nav', { class: 'crumbs' }, [link]), header.firstChild);
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    languageLink();
    var cases = Array.prototype.slice.call(document.querySelectorAll('article.tc[id]'));
    if (cases.length) renderChecklist(cases);
    else renderIndex();
  });
})();
