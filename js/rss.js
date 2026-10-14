/*
 * Feed Tool — reading and writing RSS files.
 *
 * Output follows the layout of a handwritten feed:
 *
 *   <?xml version="1.0" encoding="UTF-8" ?>
 *   <rss version="2.0">
 *     <channel>
 *       <title>…</title>
 *       <description>…</description>
 *       <link>…</link>
 *       <!-- top of entries -->
 *       <item>
 *         <title>…</title>
 *         <link>…</link>
 *         <description>…</description>
 *         <pubDate>Sat, 03 Oct 2026 14:31:00 EST</pubDate>
 *       </item>
 *       <!-- entry divider -->
 *       <item>…</item>
 *       <!-- bottom of entries -->
 *     </channel>
 *   </rss>
 *
 * Other elements found in an uploaded feed (on the channel or on items) are
 * kept as raw XML and written back after the standard ones.
 */
(function (global) {
  'use strict';

  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var CHANNEL_FIELDS = ['title', 'description', 'link'];
  var ITEM_FIELDS = ['title', 'link', 'description', 'pubDate'];

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function escapeText(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(s) { return escapeText(s).replace(/"/g, '&quot;'); }

  // --- dates ------------------------------------------------------------------

  /**
   * "2026-10-03T14:31:00" + "EST" -> "Sat, 03 Oct 2026 14:31:00 EST".
   * The time is written as-is (no zone conversion); the weekday is computed.
   */
  function formatPubDate(date, tz) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(date || '');
    if (!m) return '';
    var y = +m[1], mo = +m[2], d = +m[3];
    var weekday = DAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
    return weekday + ', ' + m[3] + ' ' + MONTHS[mo - 1] + ' ' + m[1] + ' ' + m[4] + ':' + m[5] + ':' + m[6] + (tz ? ' ' + tz : '');
  }

  /**
   * Lenient RFC 822 parsing: "Wed, 09 Sept 2026 12:37:00 EST" ->
   * { date: "2026-09-09T12:37:00", tz: "EST" }, or null. The weekday is ignored.
   */
  function parsePubDate(text) {
    var m = /^\s*(?:[A-Za-z]+\.?,?\s+)?(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{2}|\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([A-Za-z]{1,5}|[+-]\d{4})?\s*$/.exec(text || '');
    if (!m) return null;
    var mo = MONTHS.map(function (x) { return x.toLowerCase(); }).indexOf(m[2].slice(0, 3).toLowerCase());
    if (mo < 0) return null;
    var y = +m[3];
    if (y < 100) y += y < 70 ? 2000 : 1900;
    var d = +m[1], hh = +m[4], mm = +m[5], ss = m[6] ? +m[6] : 0;
    var check = new Date(Date.UTC(y, mo, d));
    if (check.getUTCMonth() !== mo || hh > 23 || mm > 59 || ss > 60) return null;
    return {
      date: y + '-' + pad(mo + 1) + '-' + pad(d) + 'T' + pad(hh) + ':' + pad(mm) + ':' + pad(Math.min(ss, 59)),
      tz: m[7] || ''
    };
  }

  /** What an item's <pubDate> will contain. */
  function itemPubDate(item) {
    return item.date ? formatPubDate(item.date, item.tz) : (item.rawDate || '');
  }

  /** The current local time as "YYYY-MM-DDTHH:MM:SS". */
  function nowLocal() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  // --- writing ----------------------------------------------------------------

  function element(indent, name, value) {
    return indent + '<' + name + '>' + escapeText(value) + '</' + name + '>';
  }

  function generate(feed) {
    var ch = feed.channel;
    var attrs = [['version', '2.0']].concat(feed.rssAttrs || []);
    var lines = [
      '<?xml version="1.0" encoding="UTF-8" ?>',
      '<rss ' + attrs.map(function (a) { return a[0] + '="' + escapeAttr(a[1]) + '"'; }).join(' ') + '>',
      '  <channel>'
    ];
    CHANNEL_FIELDS.forEach(function (k) {
      if (ch[k] || k === 'title') lines.push(element('    ', k, ch[k]));
    });
    (ch.extra || []).forEach(function (x) { lines.push('    ' + x.trim()); });
    lines.push('    <!-- top of entries -->');
    feed.items.forEach(function (item, i) {
      if (i > 0) lines.push('    <!-- entry divider -->');
      lines.push('    <item>');
      if (item.title || !item.description) lines.push(element('      ', 'title', item.title));
      if (item.link) lines.push(element('      ', 'link', item.link));
      if (item.description) lines.push(element('      ', 'description', item.description));
      var pub = itemPubDate(item);
      if (pub) lines.push(element('      ', 'pubDate', pub));
      (item.extra || []).forEach(function (x) { lines.push('      ' + x.trim()); });
      lines.push('    </item>');
    });
    lines.push('    <!-- bottom of entries -->', '  </channel>', '</rss>', '');
    return lines.join('\n');
  }

  // --- reading ----------------------------------------------------------------

  function childElements(el) {
    return Array.prototype.filter.call(el.childNodes, function (n) { return n.nodeType === 1; });
  }

  function text(el) { return el ? el.textContent.trim() : ''; }

  /**
   * Parse an RSS 2.0 file. Returns fields for a new feed
   * ({ channel, rssAttrs, timezone, items }) or throws an Error with a
   * user-readable message.
   */
  function parse(source) {
    var doc = new DOMParser().parseFromString(String(source), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      throw new Error('That file isn’t valid XML, so it can’t be read as a feed.');
    }
    var root = doc.documentElement;
    if (!root || root.localName !== 'rss') {
      throw new Error(root && root.localName === 'feed'
        ? 'That’s an Atom feed. Only RSS feeds can be uploaded.'
        : 'That file isn’t an RSS feed.');
    }
    var channel = childElements(root).filter(function (el) { return el.localName === 'channel'; })[0];
    if (!channel) throw new Error('That feed has no <channel>.');

    var serializer = new XMLSerializer();
    var rssAttrs = Array.prototype.filter.call(root.attributes, function (a) { return a.name !== 'version'; })
      .map(function (a) { return [a.name, a.value]; });
    // Namespace declarations live on <rss>, so kept elements don't need their own.
    var declared = rssAttrs.filter(function (a) { return a[0].indexOf('xmlns') === 0; });
    function raw(el) {
      var s = serializer.serializeToString(el);
      declared.forEach(function (a) {
        s = s.split(' ' + a[0] + '="' + escapeAttr(a[1]) + '"').join('');
      });
      return s;
    }
    function isPlain(el, names) { return !el.prefix && names.indexOf(el.localName) >= 0; }

    var out = { channel: { title: '', description: '', link: '', extra: [] }, rssAttrs: rssAttrs, items: [] };
    var seen = {};
    childElements(channel).forEach(function (el) {
      if (el.localName === 'item' && !el.prefix) {
        out.items.push(parseItem(el));
      } else if (isPlain(el, CHANNEL_FIELDS) && !seen[el.localName]) {
        seen[el.localName] = true;
        out.channel[el.localName] = text(el);
      } else {
        out.channel.extra.push(raw(el));
      }
    });

    function parseItem(itemEl) {
      var item = { title: '', link: '', description: '', date: '', tz: '', rawDate: '', extra: [] };
      var got = {};
      childElements(itemEl).forEach(function (el) {
        if (!isPlain(el, ITEM_FIELDS) || got[el.localName]) { item.extra.push(raw(el)); return; }
        got[el.localName] = true;
        if (el.localName !== 'pubDate') { item[el.localName] = text(el); return; }
        item.originalDate = text(el);
        var parsed = parsePubDate(item.originalDate);
        if (parsed) { item.date = parsed.date; item.tz = parsed.tz; } else item.rawDate = text(el);
      });
      return item;
    }

    // The zone used most often becomes the default for new items.
    var counts = {};
    out.items.forEach(function (it) { if (it.tz) counts[it.tz] = (counts[it.tz] || 0) + 1; });
    var best = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; })[0];
    out.timezone = best || '';
    out.items.forEach(function (it) { if (it.date && !it.tz) it.tz = best || 'GMT'; });
    return out;
  }

  global.FT = global.FT || {};
  global.FT.rss = {
    generate: generate,
    parse: parse,
    formatPubDate: formatPubDate,
    parsePubDate: parsePubDate,
    itemPubDate: itemPubDate,
    nowLocal: nowLocal
  };
})(window);
