/* Hawkes Analytics on hawkesgen.ai (the contract is hawkesgen/docs/analytics.md).
   site/index.html loads Gen's SDK from https://gen.hawkesgen.ai/sdk/analytics@1.js (deferred) and then this file,
   right after it. The SDK sends page views, referrers, UTM tags, the device, outbound links and the place by itself.
   This file adds:
   - debug mode in a playtest bot's tab (data-debug="1" before the deferred SDK runs), so playtests can read
     window.hawkesAnalytics.debugLog;
   - read depth: `progress` (step 25, 50, 75, 100 of 100) as the page is read, with the current section heading;
   - key CTA / outbound click tagging (product video on YouTube, Twitch, Hawkes Biomedical, Sign in).
   Nothing here ever throws into the page. */
(function () {
  'use strict';

  var MARKS = [25, 50, 75, 100];

  var A = function () {
    return window.hawkesAnalytics;
  };
  var safe = function (fn) {
    return function () {
      try {
        return fn.apply(this, arguments);
      } catch (e) {
        /* analytics never breaks the page */
      }
    };
  };

  /* ---------------- debug in a playtest bot's tab (before the deferred SDK runs) ---------------- */
  safe(function () {
    var q = new URLSearchParams(location.search);
    var bot = navigator.webdriver || q.get('playtest') || q.has('hawkesPlaytest') || sessionStorage.getItem('hawkes.playtest');
    var sdk = document.querySelector('script[data-product][src*="analytics"]');
    if (bot && sdk) sdk.setAttribute('data-debug', '1');
  })();

  /* ---------------- key CTA / outbound clicks ---------------- */
  var targetOf = function (href) {
    try {
      var u = new URL(href, location.href);
      if (!/^https?:$/.test(u.protocol)) return null;
      var host = u.hostname.replace(/^www\./, '').toLowerCase();
      if (host === 'youtu.be' || host === 'youtube.com') return { id: 'product_video', label: 'Product video (YouTube)' };
      if (host === 'twitch.tv') return { id: 'twitch', label: 'Twitch' };
      if (host === 'hawkesbiomedical.com') return { id: 'hawkes_biomedical', label: 'Hawkes Biomedical' };
      if (host === 'gen.hawkesgen.ai') return { id: 'sign_in', label: 'Sign in' };
      return null;
    } catch (e) {
      return null;
    }
  };

  var whereOf = function (link) {
    if (!link || !link.closest) return 'page';
    if (link.closest('nav')) return 'nav';
    if (link.closest('.hero')) return 'hero';
    if (link.closest('#live')) return 'live';
    if (link.closest('#soon')) return 'cta';
    if (link.closest('footer')) return 'footer';
    return 'page';
  };

  // The SDK records `outbound` in its capture listener on document; this one on window runs just before it, so the
  // tagged target and section ride on that same `outbound` event (ctx is copied onto each event) and a `feature`
  // event records the CTA click as well.
  window.addEventListener(
    'click',
    safe(function (e) {
      var a = A();
      var link = e.target && e.target.closest && e.target.closest('a[href]');
      var tag = link && targetOf(link.href);
      if (!a || !tag) return;
      var where = whereOf(link);
      a.setContext({ cta: tag.id, target: tag.label, where: where });
      a.feature('cta:' + tag.id, { target: tag.label, where: where });
      setTimeout(
        safe(function () {
          a.setContext({ cta: null, target: null, where: null });
        }),
        0
      );
    }),
    { capture: true }
  );

  /* ---------------- read depth ---------------- */
  function readDepth() {
    var a = A();
    if (!a) return;
    var sent = 0;
    var heads = [].slice.call(document.querySelectorAll('main h1, main h2'));
    var measure = safe(function () {
      var doc = document.documentElement;
      var total = Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0);
      var seen = window.scrollY + window.innerHeight;
      var pct = total > 0 ? Math.min(100, (seen / total) * 100) : 100;
      if (total - seen < 4) pct = 100;
      var section = '';
      for (var i = 0; i < heads.length; i++) {
        if (heads[i].getBoundingClientRect().top < window.innerHeight) {
          section = heads[i].textContent.replace(/\s+/g, ' ').trim();
        }
      }
      for (var m = 0; m < MARKS.length; m++) {
        var mark = MARKS[m];
        if (mark <= sent || pct < mark) continue;
        sent = mark;
        a.track('progress', { step: mark, of: 100, label: 'read ' + mark + '%', section: section.slice(0, 80) || undefined });
      }
    });
    var queued = false;
    var onScroll = function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        measure();
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    if (document.readyState === 'complete') measure();
    else window.addEventListener('load', measure);
  }

  // The SDK is deferred: it has run by DOMContentLoaded.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', safe(readDepth));
  else safe(readDepth)();
})();
