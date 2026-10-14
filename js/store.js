/*
 * Feed Tool — data store.
 *
 * Holds the whole database in memory, persists it to localStorage, and keeps
 * an undo/redo history. Every change goes through `commit()` so that saving,
 * history and re-rendering happen in one place.
 *
 * Database shape (schemaVersion 1):
 *
 *   {
 *     schemaVersion: 1,
 *     activeFeedId: "<feed id>",
 *     feedOrderUpdatedAt: "<ISO time>",           // last time feeds were added/removed
 *     deletedFeeds: { "<feed id>": "<ISO time>" }, // tombstones, so sync can propagate deletions
 *     feeds: [{
 *       id, createdAt, updatedAt,
 *       fileName: "miniblog.xml",                  // used when downloading
 *       timezone: "EST",                           // default zone for new items
 *       rssAttrs: [["xmlns:atom", "…"]],           // extra attributes on <rss>, kept from imports
 *       channel: { title, description, link, extra: ["<raw xml>", …] },
 *       items: [{
 *         id, title, link, description,
 *         date: "2026-10-03T14:31:00",             // wall-clock time as written, or ""
 *         tz: "EST",                               // zone label written after the time
 *         rawDate: "",                             // an imported pubDate that couldn't be parsed
 *         extra: ["<raw xml>", …]                  // other item elements, kept from imports
 *       }]
 *     }]
 *   }
 *
 * Items are always kept newest first by date (the order they're written to
 * the file). Items without a date go first: they're usually drafts that are
 * still being written. Each
 * feed's `updatedAt` changes on every edit inside it. Sync (js/sync.js)
 * merges whole feeds by comparing these timestamps.
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'feedTool.db';
  var SCHEMA_VERSION = 1;
  var HISTORY_LIMIT = 100;
  var COALESCE_MS = 1500;
  var DEFAULT_TZ = 'EST';
  var DEFAULT_TITLE = 'Untitled feed';

  function uid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function now() { return new Date().toISOString(); }

  // Ids come from this app (UUIDs), but synced data is validated too: ids end
  // up in DOM attributes, object keys and Nostr `d` tags.
  var ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  var DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
  var ATTR_RE = /^[A-Za-z_][\w.:-]{0,100}$/;
  function isId(id) { return typeof id === 'string' && ID_RE.test(id) && id !== '__proto__'; }
  function str(value, max) { return typeof value === 'string' ? value.slice(0, max) : ''; }
  function isoOr(value, fallback) { return typeof value === 'string' && value ? value : fallback; }
  function strList(list) {
    return Array.isArray(list) ? list.filter(function (x) { return typeof x === 'string' && x.trim(); }).slice(0, 200) : [];
  }

  /** "2026-10-03T14:31" or "2026-10-03T14:31:05" -> "2026-10-03T14:31:05"; anything else -> "". */
  function cleanDate(value) {
    if (typeof value !== 'string') return '';
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) value += ':00';
    return DATE_RE.test(value) ? value : '';
  }

  function cleanTz(value, fallback) {
    var tz = typeof value === 'string' ? value.trim().slice(0, 10) : '';
    return /^([A-Za-z]{1,5}|[+-]\d{4})$/.test(tz) ? tz : fallback;
  }

  function cleanFileName(name) {
    var n = String(name || '').trim().replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-').slice(0, 120);
    return n || 'feed.xml';
  }

  function createItem(fields, tz) {
    fields = fields || {};
    return {
      id: uid(),
      title: str(fields.title, 2000),
      link: str(fields.link, 4000),
      description: str(fields.description, 20000),
      date: cleanDate(fields.date),
      tz: cleanTz(fields.tz, tz || DEFAULT_TZ),
      rawDate: str(fields.rawDate, 200),
      extra: strList(fields.extra)
    };
  }

  function createFeed(fields) {
    fields = fields || {};
    var t = now();
    var ch = fields.channel || {};
    var tz = cleanTz(fields.timezone, DEFAULT_TZ);
    return {
      id: uid(),
      createdAt: t,
      updatedAt: t,
      fileName: cleanFileName(fields.fileName),
      timezone: tz,
      rssAttrs: cleanAttrs(fields.rssAttrs),
      channel: {
        title: typeof ch.title === 'string' ? str(ch.title, 2000) : DEFAULT_TITLE,
        description: str(ch.description, 20000),
        link: str(ch.link, 4000),
        extra: strList(ch.extra)
      },
      items: sortByDate((Array.isArray(fields.items) ? fields.items : []).map(function (it) { return createItem(it, tz); }))
    };
  }

  function cleanAttrs(list) {
    if (!Array.isArray(list)) return [];
    var seen = {};
    return list.filter(function (a) {
      if (!Array.isArray(a) || typeof a[0] !== 'string' || typeof a[1] !== 'string') return false;
      if (!ATTR_RE.test(a[0]) || a[0] === 'version' || seen[a[0]]) return false;
      seen[a[0]] = true;
      return true;
    }).map(function (a) { return [a[0], a[1].slice(0, 2000)]; }).slice(0, 50);
  }

  function createDatabase() {
    var feed = createFeed();
    return { schemaVersion: SCHEMA_VERSION, activeFeedId: feed.id, feedOrderUpdatedAt: now(), deletedFeeds: {}, feeds: [feed] };
  }

  /**
   * Newest first by date, as written (zone labels aren't converted). Items
   * without a date go first; ties keep their current relative order.
   */
  function sortByDate(items) {
    var pos = new Map();
    items.forEach(function (it, i) { pos.set(it, i); });
    items.sort(function (a, b) {
      if (a.date !== b.date) {
        if (!a.date) return -1;
        if (!b.date) return 1;
        return a.date < b.date ? 1 : -1;
      }
      return pos.get(a) - pos.get(b);
    });
    return items;
  }

  /** Validate and repair a database from storage, sync, or anywhere else untrusted. */
  function normalize(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.feeds)) return createDatabase();
    var out = {
      schemaVersion: SCHEMA_VERSION,
      activeFeedId: null,
      feedOrderUpdatedAt: isoOr(raw.feedOrderUpdatedAt, ''),
      deletedFeeds: {},
      feeds: []
    };
    if (raw.deletedFeeds && typeof raw.deletedFeeds === 'object') {
      Object.keys(raw.deletedFeeds).forEach(function (id) {
        if (isId(id) && typeof raw.deletedFeeds[id] === 'string') out.deletedFeeds[id] = raw.deletedFeeds[id];
      });
    }
    var feedIds = {};
    raw.feeds.forEach(function (f) {
      if (!f || typeof f !== 'object' || !isId(f.id) || feedIds[f.id]) return;
      feedIds[f.id] = true;
      var ch = f.channel && typeof f.channel === 'object' ? f.channel : {};
      var tz = cleanTz(f.timezone, DEFAULT_TZ);
      var itemIds = {};
      var items = [];
      (Array.isArray(f.items) ? f.items : []).forEach(function (it) {
        if (!it || typeof it !== 'object') return;
        var item = createItem(it, tz);
        if (isId(it.id) && !itemIds[it.id]) item.id = it.id;
        itemIds[item.id] = true;
        items.push(item);
      });
      out.feeds.push({
        id: f.id,
        createdAt: isoOr(f.createdAt, now()),
        updatedAt: isoOr(f.updatedAt, now()),
        fileName: cleanFileName(f.fileName),
        timezone: tz,
        rssAttrs: cleanAttrs(f.rssAttrs),
        channel: {
          title: str(ch.title, 2000),
          description: str(ch.description, 20000),
          link: str(ch.link, 4000),
          extra: strList(ch.extra)
        },
        items: sortByDate(items)
      });
    });
    if (!out.feeds.length) out.feeds.push(createFeed());
    out.feeds.forEach(function (f) { delete out.deletedFeeds[f.id]; });
    out.activeFeedId = feedIds[raw.activeFeedId] ? raw.activeFeedId : out.feeds[0].id;
    return out;
  }

  /** A feed nobody has touched: default channel, no items. */
  function isPristineFeed(f) {
    return !f.items.length && (f.channel.title === DEFAULT_TITLE || !f.channel.title) &&
      !f.channel.description && !f.channel.link && !f.channel.extra.length;
  }

  // --- state ------------------------------------------------------------------

  var db = createDatabase();
  var listeners = [];
  var undoStack = [];
  var redoStack = [];
  var lastCoalesce = { key: null, at: 0 };
  var lastSaveError = null;

  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  function emit(meta) { listeners.forEach(function (fn) { fn(meta || {}); }); }

  function persist() {
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
      lastSaveError = null;
    } catch (err) {
      lastSaveError = err;
    }
  }

  function load() {
    var raw = null;
    try { raw = JSON.parse(global.localStorage.getItem(STORAGE_KEY)); } catch (err) { raw = null; }
    db = raw ? normalize(raw) : createDatabase();
  }

  /**
   * Apply `mutator` to a copy of the database. Options:
   *   history: false   -> not undoable (navigation, sync)
   *   coalesce: key    -> edits with the same key in quick succession are one undo step
   *   local: true      -> passed to listeners: the UI already shows this change
   */
  function commit(mutator, options) {
    options = options || {};
    var next = clone(db);
    var result = mutator(next);
    if (JSON.stringify(next) === JSON.stringify(db)) return result;
    if (options.history !== false) {
      var t = Date.now();
      var merge = options.coalesce && lastCoalesce.key === options.coalesce && t - lastCoalesce.at < COALESCE_MS;
      if (!merge) {
        undoStack.push(db);
        if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
      }
      redoStack = [];
      lastCoalesce = { key: options.coalesce || null, at: t };
    }
    db = next;
    persist();
    emit(options);
    return result;
  }

  /**
   * Undo/redo restores an older snapshot. Bump the timestamps of whatever
   * changed so that sync treats the restored state as the newest edit.
   */
  function restore(fromStack, toStack) {
    if (!fromStack.length) return false;
    var prev = db;
    var next = clone(fromStack.pop());
    var t = now();
    var prevById = {};
    prev.feeds.forEach(function (f) { prevById[f.id] = f; });
    next.feeds.forEach(function (f) {
      var old = prevById[f.id];
      if (!old || JSON.stringify(old) !== JSON.stringify(f)) f.updatedAt = t;
      delete next.deletedFeeds[f.id];
    });
    var nextIds = next.feeds.map(function (f) { return f.id; });
    prev.feeds.forEach(function (f) { if (nextIds.indexOf(f.id) < 0) next.deletedFeeds[f.id] = t; });
    if (prev.feeds.map(function (f) { return f.id; }).join() !== nextIds.join()) next.feedOrderUpdatedAt = t;
    if (!nextIds.some(function (id) { return id === next.activeFeedId; })) next.activeFeedId = nextIds[0];
    toStack.push(prev);
    db = next;
    lastCoalesce = { key: null, at: 0 };
    persist();
    emit({ restored: true });
    return true;
  }

  function feedById(d, id) {
    for (var i = 0; i < d.feeds.length; i++) if (d.feeds[i].id === id) return d.feeds[i];
    return null;
  }

  function itemIndex(feed, itemId) {
    for (var i = 0; i < feed.items.length; i++) if (feed.items[i].id === itemId) return i;
    return -1;
  }

  /** Run `fn(feed, d)` on one feed and mark it edited. */
  function onFeed(feedId, fn, options) {
    return commit(function (d) {
      var feed = feedById(d, feedId);
      if (!feed) return undefined;
      var before = JSON.stringify(feed);
      var result = fn(feed, d);
      sortByDate(feed.items);
      if (JSON.stringify(feed) !== before) feed.updatedAt = now();
      return result;
    }, options);
  }

  var Store = {
    DEFAULT_TZ: DEFAULT_TZ,
    STORAGE_KEY: STORAGE_KEY,
    normalize: normalize,
    cleanTz: cleanTz,

    init: function () {
      load();
      // Follow edits made in another open tab of the app.
      global.addEventListener('storage', function (e) {
        if (e.key !== STORAGE_KEY && e.key !== null) return;
        load();
        emit({ external: true });
      });
    },

    subscribe: function (fn) { listeners.push(fn); },
    getDb: function () { return db; },
    saveError: function () { return lastSaveError; },
    activeFeed: function () { return feedById(db, db.activeFeedId) || db.feeds[0]; },
    getFeed: function (id) { return feedById(db, id); },
    isPristine: function () {
      return db.feeds.length === 1 && isPristineFeed(db.feeds[0]) && !Object.keys(db.deletedFeeds).length;
    },

    canUndo: function () { return undoStack.length > 0; },
    canRedo: function () { return redoStack.length > 0; },
    undo: function () { return restore(undoStack, redoStack); },
    redo: function () { return restore(redoStack, undoStack); },

    // --- feeds ---

    addFeed: function (fields) {
      return commit(function (d) {
        var feed = createFeed(fields);
        d.feeds.push(feed);
        d.activeFeedId = feed.id;
        d.feedOrderUpdatedAt = now();
        return feed.id;
      });
    },

    /**
     * Add an imported feed. If the active feed is untouched, the import
     * replaces it instead of sitting next to an empty one.
     */
    importFeed: function (fields) {
      return commit(function (d) {
        var feed = createFeed(fields);
        var active = feedById(d, d.activeFeedId);
        if (active && isPristineFeed(active)) {
          var i = d.feeds.indexOf(active);
          d.feeds.splice(i, 1, feed);
          d.deletedFeeds[active.id] = now();
        } else {
          d.feeds.push(feed);
        }
        d.activeFeedId = feed.id;
        d.feedOrderUpdatedAt = now();
        return feed.id;
      });
    },

    deleteFeed: function (feedId) {
      commit(function (d) {
        var i = d.feeds.findIndex(function (f) { return f.id === feedId; });
        if (i < 0) return;
        d.feeds.splice(i, 1);
        d.deletedFeeds[feedId] = now();
        if (!d.feeds.length) d.feeds.push(createFeed());
        if (d.activeFeedId === feedId) d.activeFeedId = d.feeds[Math.min(i, d.feeds.length - 1)].id;
        d.feedOrderUpdatedAt = now();
      });
    },

    setActiveFeed: function (feedId) {
      commit(function (d) { if (feedById(d, feedId)) d.activeFeedId = feedId; }, { history: false, navigation: true });
    },

    /** Channel fields (title, description, link) and feed settings (fileName, timezone). */
    updateFeed: function (feedId, patch, options) {
      onFeed(feedId, function (feed) {
        ['title', 'description', 'link'].forEach(function (k) {
          if (typeof patch[k] === 'string') feed.channel[k] = patch[k];
        });
        if (typeof patch.fileName === 'string') feed.fileName = cleanFileName(patch.fileName);
        if (typeof patch.timezone === 'string') feed.timezone = cleanTz(patch.timezone, feed.timezone);
      }, options);
    },

    // --- items ---

    addItem: function (feedId, fields) {
      return onFeed(feedId, function (feed) {
        var item = createItem(fields, feed.timezone);
        feed.items.unshift(item);
        return item.id;
      });
    },

    updateItem: function (feedId, itemId, patch, options) {
      onFeed(feedId, function (feed) {
        var i = itemIndex(feed, itemId);
        if (i < 0) return;
        var item = feed.items[i];
        ['title', 'link', 'description'].forEach(function (k) {
          if (typeof patch[k] === 'string') item[k] = patch[k];
        });
        if (typeof patch.date === 'string') {
          item.date = cleanDate(patch.date);
          item.rawDate = '';
        }
        if (typeof patch.tz === 'string') item.tz = cleanTz(patch.tz, item.tz);
      }, options);
    },

    deleteItem: function (feedId, itemId) {
      onFeed(feedId, function (feed) {
        var i = itemIndex(feed, itemId);
        if (i >= 0) feed.items.splice(i, 1);
      });
    },

    // --- used by sync ---

    /** Replace the database with a merged copy from sync (not undoable). */
    applySynced: function (next) {
      var active = db.activeFeedId;
      next = normalize(next);
      if (feedById(next, active)) next.activeFeedId = active;
      commit(function (d) {
        Object.keys(d).forEach(function (k) { delete d[k]; });
        Object.keys(next).forEach(function (k) { d[k] = next[k]; });
      }, { history: false, synced: true });
    },

    /** Start over with `next` (or a fresh database), clearing history. */
    resetDatabase: function (next) {
      db = next ? normalize(next) : createDatabase();
      undoStack = [];
      redoStack = [];
      persist();
      emit({ reset: true });
    }
  };

  global.FT = global.FT || {};
  global.FT.store = Store;
})(window);
