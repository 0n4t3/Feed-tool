/*
 * Feed Tool — end-to-end encrypted sync over Nostr.
 *
 * Adapted from the Story Outline Tool (https://github.com/0n4t3/story-tool).
 *
 * How the data is stored on relays:
 *   - Every feed is one NIP-78 application-data event (kind 30078) with
 *     the `d` tag "feed-tool/feed/<feed id>". Its content is the feed,
 *     gzipped and NIP-44 encrypted to the user's own key, so only the holder
 *     of the key can read it. A deleted feed becomes `{ deletedAt }`.
 *   - One index event ("feed-tool/index") holds the feed order and
 *     the deleted-feed list.
 * These are replaceable events: a newer one with the same `d` tag replaces the
 * old one on the relay.
 *
 * What relays can see: the account's public key, event timestamps, the `d`
 * tags (so: that this app is used, how many feeds there are and their
 * random ids) and the size of each encrypted feed. Never names or contents.
 *
 * Merging: whole feeds, newest `updatedAt` wins. A deletion wins over edits
 * made before it, and loses to edits made after it.
 *
 * Signing in, three ways:
 *   - "key": a secret key generated here or pasted in (nsec). Kept in this
 *     browser's localStorage.
 *   - "extension": a NIP-07 browser extension (needs NIP-44 support).
 *   - "bunker": a NIP-46 remote signer (bunker:// URI). Encryption happens in
 *     the signer, so the signer sees the plaintext.
 */
(function (global) {
  'use strict';

  var NT = global.NostrTools;
  var store = global.FT.store;

  var ACCOUNT_KEY = 'feedTool.sync';
  var KIND = 30078;
  var D_PREFIX = 'feed-tool/';
  var D_INDEX = D_PREFIX + 'index';
  var D_FEED = D_PREFIX + 'feed/';
  // NIP-44 allows 65535 bytes of plaintext, but many relays reject events over
  // 64 KiB, and base64 ciphertext is ~4/3 the plaintext size.
  var MAX_PLAINTEXT = 46000;
  var DEFAULT_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://offchain.pub'];
  var AUTO_SYNC_DELAY = 3000;
  var POLL_INTERVAL = 90 * 1000;
  var QUERY_WAIT = 8000;
  var D_BATCH = 100;

  // Saved in localStorage:
  //   { method, pubkey, sk?, bunker?: { pointer, clientSk }, relays, seen, feedIds, lastSyncedAt }
  // `seen[d]` is the last version ({ id, created_at, stamp }) of each event
  // this device merged or published, so unchanged events aren't decrypted
  // again. `feedIds` are the feed ids the synced index last listed.
  var account = null;
  var signer = null;
  var pool = null;
  var status = { state: 'off', message: '' };
  var listeners = [];
  var running = null;
  var rerun = false;
  var paused = false;
  var timer = 0;
  // Bumped whenever the account changes; an in-flight sync for an older
  // generation stops at its next step instead of writing anything.
  var generation = 0;
  var CANCELLED = { cancelled: true };

  // --- helpers --------------------------------------------------------------

  function noop() {}

  function bytesToHex(bytes) {
    return Array.prototype.map.call(bytes, function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join('');
  }
  function hexToBytes(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  function bytesToBase64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function base64ToBytes(b64) {
    var s = atob(b64);
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function hash(str) {
    var h = 5381;
    for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + ':' + str.length;
  }
  function withTimeout(promise, ms, message) {
    return Promise.race([promise, new Promise(function (_, reject) {
      setTimeout(function () { reject(new Error(message)); }, ms);
    })]);
  }
  function nowSeconds() { return Math.floor(Date.now() / 1000); }
  function isPubkey(pk) { return typeof pk === 'string' && /^[0-9a-f]{64}$/.test(pk); }
  function unique(list) { return list.filter(function (x, i) { return x && list.indexOf(x) === i; }); }

  function emit() { listeners.forEach(function (fn) { fn(getStatus()); }); }
  function setStatus(state, message) {
    status = { state: state, message: message || '' };
    emit();
  }

  function saveAccount() {
    try {
      if (account) global.localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
      else global.localStorage.removeItem(ACCOUNT_KEY);
    } catch (err) { /* storage unavailable: sync still works for this session */ }
  }

  function parseAccount(raw) {
    var a;
    try { a = raw ? JSON.parse(raw) : null; } catch (err) { a = null; }
    if (!a || !isPubkey(a.pubkey) || ['key', 'extension', 'bunker'].indexOf(a.method) < 0) return null;
    if (a.method === 'key' && !/^[0-9a-f]{64}$/.test(a.sk || '')) return null;
    if (a.method === 'bunker' && !(a.bunker && a.bunker.pointer && /^[0-9a-f]{64}$/.test(a.bunker.clientSk || ''))) return null;
    a.seen = a.seen && typeof a.seen === 'object' ? a.seen : {};
    a.feedIds = Array.isArray(a.feedIds) ? a.feedIds : [];
    a.relays = Array.isArray(a.relays) && a.relays.length ? a.relays : DEFAULT_RELAYS.slice();
    return a;
  }

  function loadAccount() {
    var raw = null;
    try { raw = global.localStorage.getItem(ACCOUNT_KEY); } catch (err) { raw = null; }
    account = parseAccount(raw);
  }

  function relays() { return (account && account.relays) || DEFAULT_RELAYS; }

  function getPool() {
    if (!pool) pool = new NT.SimplePool();
    return pool;
  }

  // --- payloads -------------------------------------------------------------

  function gzip(text) {
    var stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Response(stream).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }
  function gunzip(bytes) {
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }

  function pack(obj, label) {
    var json = JSON.stringify(obj);
    var build = global.CompressionStream
      ? gzip(json).then(function (gz) { return JSON.stringify({ v: 1, gz: bytesToBase64(gz) }); })
      : Promise.resolve(JSON.stringify({ v: 1, json: json }));
    return build.then(function (text) {
      if (new TextEncoder().encode(text).length > MAX_PLAINTEXT) {
        throw new Error('“' + (label || 'This feed') + '” is too large to sync.');
      }
      return text;
    });
  }

  function unpack(text) {
    var o = JSON.parse(text);
    if (o && typeof o.gz === 'string') return gunzip(base64ToBytes(o.gz)).then(JSON.parse);
    if (o && typeof o.json === 'string') return Promise.resolve(JSON.parse(o.json));
    return Promise.resolve(null);
  }

  // --- signers --------------------------------------------------------------

  function localSigner(skHex) {
    var sk = hexToBytes(skHex);
    var pk = NT.getPublicKey(sk);
    var ck = NT.nip44.getConversationKey(sk, pk);
    return {
      pubkey: pk,
      sign: function (t) { return Promise.resolve(NT.finalizeEvent(t, sk)); },
      encrypt: function (text) { return Promise.resolve(NT.nip44.encrypt(text, ck)); },
      decrypt: function (ct) { return Promise.resolve(NT.nip44.decrypt(ct, ck)); }
    };
  }

  function extensionSigner(pubkey) {
    var ext = global.nostr;
    if (!ext) throw new Error('No Nostr browser extension was found. Install or unlock one, then try again.');
    if (!ext.nip44) throw new Error('Your Nostr extension doesn’t support NIP-44 encryption, which sync needs.');
    return {
      pubkey: pubkey,
      sign: function (t) { return ext.signEvent(t); },
      encrypt: function (text) { return ext.nip44.encrypt(pubkey, text); },
      decrypt: function (ct) { return ext.nip44.decrypt(pubkey, ct); }
    };
  }

  /** Bunkers may ask the user to approve in a web page. Only ever open https pages. */
  function openAuthUrl(url) {
    var u;
    try { u = new URL(url); } catch (err) { return; }
    if (u.protocol === 'https:') global.open(u.href, '_blank', 'noopener,noreferrer');
  }

  function wrapBunker(bs, pubkey) {
    return {
      pubkey: pubkey,
      sign: function (t) { return bs.signEvent(t); },
      encrypt: function (text) { return bs.nip44Encrypt(pubkey, text); },
      decrypt: function (ct) { return bs.nip44Decrypt(pubkey, ct); },
      close: function () { return bs.close(); }
    };
  }

  function getSigner() {
    if (signer) return signer;
    if (!account) throw new Error('Sync isn’t set up.');
    if (account.method === 'key') signer = localSigner(account.sk);
    else if (account.method === 'extension') signer = extensionSigner(account.pubkey);
    else if (account.method === 'bunker') {
      var bs = NT.BunkerSigner.fromBunker(hexToBytes(account.bunker.clientSk), account.bunker.pointer,
        { pool: getPool(), onauth: openAuthUrl });
      signer = wrapBunker(bs, account.pubkey);
    }
    return signer;
  }

  // --- relay I/O ------------------------------------------------------------

  function dTag(ev) {
    for (var i = 0; i < ev.tags.length; i++) if (ev.tags[i][0] === 'd') return ev.tags[i][1];
    return null;
  }

  /**
   * Newest event for each of the given `d` tags, keyed by `d`. Queries by
   * exact `d` tag so that other apps' kind-30078 events on the same account
   * can't crowd ours out of a relay's result limit.
   */
  function query(pubkey, ds) {
    var batches = [];
    for (var i = 0; i < ds.length; i += D_BATCH) batches.push(ds.slice(i, i + D_BATCH));
    return Promise.all(batches.map(function (batch) {
      return getPool().querySync(relays(), { kinds: [KIND], authors: [pubkey], '#d': batch }, { maxWait: QUERY_WAIT });
    })).then(function (results) {
      var latest = {};
      results.forEach(function (events) {
        events.forEach(function (ev) {
          // nostr-tools already checks signatures and the filter; this is a second line of defence.
          if (ev.pubkey !== pubkey || ev.kind !== KIND) return;
          var d = dTag(ev);
          if (!d || ds.indexOf(d) < 0) return;
          var cur = latest[d];
          if (!cur || ev.created_at > cur.created_at || (ev.created_at === cur.created_at && ev.id < cur.id)) latest[d] = ev;
        });
      });
      return latest;
    });
  }

  /** Decrypt an event's payload, or null if it is empty or unreadable. */
  function open(s, ev) {
    if (!ev.content) return Promise.resolve(null);
    return s.decrypt(ev.content).then(unpack).catch(function () { return null; });
  }

  function isNewer(ev, prev) {
    return !prev || ev.created_at > prev.created_at || (ev.created_at === prev.created_at && ev.id !== prev.id);
  }

  function publishEvent(s, template) {
    return s.sign(template).then(function (ev) {
      var attempts = getPool().publish(relays(), ev, { maxWait: QUERY_WAIT });
      return Promise.any(attempts).then(function () { return ev; }, function () {
        throw new Error('None of the sync relays accepted the update. Check your connection and try again.');
      });
    });
  }

  function publishPayload(ctx, d, payload, stamp, label) {
    var acct = ctx.account;
    var prev = acct.seen[d];
    var createdAt = Math.max(nowSeconds(), prev ? prev.created_at + 1 : 0);
    return pack(payload, label).then(function (text) {
      ctx.check();
      return ctx.signer.encrypt(text);
    }).then(function (content) {
      ctx.check();
      return publishEvent(ctx.signer, { kind: KIND, created_at: createdAt, tags: [['d', d]], content: content });
    }).then(function (ev) {
      ctx.check();
      acct.seen[d] = { id: ev.id, created_at: createdAt, stamp: stamp };
      saveAccount();
    });
  }

  function stampFor(d, payload) {
    if (!payload) return null;
    if (d === D_INDEX) return hash(JSON.stringify(payload));
    if (payload.feed) return payload.feed.updatedAt;
    if (payload.deletedAt) return 'deleted:' + payload.deletedAt;
    return null;
  }

  function indexPayload(db) {
    return { feedOrder: db.feeds.map(function (f) { return f.id; }), feedOrderUpdatedAt: db.feedOrderUpdatedAt, deletedFeeds: db.deletedFeeds };
  }

  function idsFromIndex(index) {
    if (!index || typeof index !== 'object') return [];
    var ids = Array.isArray(index.feedOrder) ? index.feedOrder.slice() : [];
    if (index.deletedFeeds && typeof index.deletedFeeds === 'object') ids = ids.concat(Object.keys(index.deletedFeeds));
    return ids.filter(function (id) { return typeof id === 'string'; });
  }

  /** Every feed id that might have an event: from the synced index, and local feeds and deletions. */
  function knownFeedDs(acct) {
    var db = store.getDb();
    var ids = acct.feedIds
      .concat(db.feeds.map(function (f) { return f.id; }))
      .concat(Object.keys(db.deletedFeeds || {}));
    return unique(ids).map(function (id) { return D_FEED + id; });
  }

  /**
   * Download and decrypt remote events. With `all` false, only events that
   * changed since this device last saw them are decrypted.
   */
  function readRemote(ctx, all) {
    var acct = ctx.account;
    var s = ctx.signer;
    var seen = all ? {} : acct.seen;
    var remote = { index: null, feeds: {}, deleted: {} };

    function record(d, ev, payload) {
      acct.seen[d] = { id: ev.id, created_at: ev.created_at, stamp: stampFor(d, payload) };
    }

    return query(s.pubkey, [D_INDEX]).then(function (latest) {
      ctx.check();
      var ev = latest[D_INDEX];
      if (!ev || !isNewer(ev, seen[D_INDEX])) return null;
      return open(s, ev).then(function (payload) {
        record(D_INDEX, ev, payload);
        if (payload) {
          remote.index = payload;
          acct.feedIds = unique(idsFromIndex(payload));
        }
      });
    }).then(function () {
      ctx.check();
      return query(s.pubkey, knownFeedDs(acct));
    }).then(function (latest) {
      ctx.check();
      var jobs = Object.keys(latest).map(function (d) {
        var ev = latest[d];
        if (!isNewer(ev, seen[d])) return null;
        return open(s, ev).then(function (payload) {
          record(d, ev, payload);
          if (!payload) return;
          var id = d.slice(D_FEED.length);
          if (payload.feed && payload.feed.id === id) remote.feeds[id] = payload.feed;
          else if (typeof payload.deletedAt === 'string') remote.deleted[id] = payload.deletedAt;
        });
      });
      return Promise.all(jobs);
    }).then(function () { return remote; });
  }

  // --- merging --------------------------------------------------------------

  function merge(local, remote) {
    var db = JSON.parse(JSON.stringify(local));
    var tombs = db.deletedFeeds || {};
    function addTomb(id, t) {
      if (typeof t === 'string' && (!Object.prototype.hasOwnProperty.call(tombs, id) || t > tombs[id])) tombs[id] = t;
    }
    Object.keys(remote.deleted).forEach(function (id) { addTomb(id, remote.deleted[id]); });
    if (remote.index && remote.index.deletedFeeds && typeof remote.index.deletedFeeds === 'object') {
      Object.keys(remote.index.deletedFeeds).forEach(function (id) { addTomb(id, remote.index.deletedFeeds[id]); });
    }

    Object.keys(remote.feeds).forEach(function (id) {
      var r = remote.feeds[id];
      var i = db.feeds.findIndex(function (f) { return f.id === id; });
      if (i < 0) db.feeds.push(r);
      else if (String(r.updatedAt) > String(db.feeds[i].updatedAt)) db.feeds[i] = r;
    });

    db.feeds = db.feeds.filter(function (t) {
      var deletedAt = Object.prototype.hasOwnProperty.call(tombs, t.id) ? tombs[t.id] : null;
      if (deletedAt && deletedAt >= String(t.updatedAt)) return false;
      if (deletedAt) delete tombs[t.id]; // edited after it was deleted elsewhere: keep it
      return true;
    });
    db.deletedFeeds = tombs;

    var idx = remote.index;
    if (idx && Array.isArray(idx.feedOrder) && String(idx.feedOrderUpdatedAt || '') > String(db.feedOrderUpdatedAt || '')) {
      var pos = new Map();
      idx.feedOrder.forEach(function (id, i) { pos.set(id, i); });
      var before = db.feeds.slice();
      var rank = function (t) { return pos.has(t.id) ? pos.get(t.id) : 1e6 + before.indexOf(t); };
      db.feeds.sort(function (a, b) { return rank(a) - rank(b); });
      db.feedOrderUpdatedAt = idx.feedOrderUpdatedAt;
    }
    return db;
  }

  // --- sync runs ------------------------------------------------------------

  /** Snapshot of the account/signer for one run, plus a check that it is still current. */
  function context() {
    var gen = generation;
    var ctx = { account: account, signer: getSigner() };
    ctx.check = function () { if (gen !== generation || ctx.account !== account) throw CANCELLED; };
    return ctx;
  }

  /**
   * mode "merge": combine local and remote data and upload what changed.
   * mode "pull": replace local data with what's on the relays.
   * Runs never overlap: a merge requested during a run is folded into one
   * follow-up merge; a pull waits for the current run to finish.
   */
  function run(mode) {
    if (running) {
      if (mode === 'merge') { rerun = true; return running; }
      return running.then(noop, noop).then(function () { return run(mode); });
    }
    if (!account) return Promise.reject(new Error('Sync isn’t set up.'));
    clearTimeout(timer);
    var gen = generation;
    var ctx;
    setStatus('syncing');
    running = Promise.resolve().then(function () {
      ctx = context();
      return readRemote(ctx, mode === 'pull');
    }).then(function (remote) {
      ctx.check();
      if (mode === 'pull') {
        var pulled = merge({ feeds: [], deletedFeeds: {}, feedOrderUpdatedAt: '' }, remote);
        store.resetDatabase(pulled.feeds.length ? pulled : null);
      } else {
        store.applySynced(merge(store.getDb(), remote));
      }
      return upload(ctx);
    }).then(function () {
      ctx.check();
      ctx.account.lastSyncedAt = new Date().toISOString();
      saveAccount();
      setStatus('synced');
    }).catch(function (err) {
      if (err === CANCELLED || gen !== generation) return;
      setStatus('error', (err && err.message) || 'Sync failed.');
      throw err;
    }).finally(function () {
      running = null;
      if (rerun && account && !paused) { rerun = false; schedule(0); }
    });
    return running;
  }

  function upload(ctx) {
    var db = store.getDb();
    var seen = ctx.account.seen;
    var tasks = [];
    db.feeds.forEach(function (feed) {
      var d = D_FEED + feed.id;
      if (!seen[d] || seen[d].stamp !== feed.updatedAt) {
        var snapshot = JSON.parse(JSON.stringify(feed));
        tasks.push(function () { return publishPayload(ctx, d, { feed: snapshot }, snapshot.updatedAt, snapshot.channel.title); });
      }
    });
    Object.keys(db.deletedFeeds).forEach(function (id) {
      var d = D_FEED + id;
      var deletedAt = db.deletedFeeds[id];
      var stamp = 'deleted:' + deletedAt;
      // Only feeds that were synced at some point need a deletion marker.
      if (seen[d] && seen[d].stamp && seen[d].stamp !== stamp) {
        tasks.push(function () { return publishPayload(ctx, d, { deletedAt: deletedAt }, stamp); });
      }
    });
    var index = JSON.parse(JSON.stringify(indexPayload(db)));
    var indexStamp = hash(JSON.stringify(index));
    if (!seen[D_INDEX] || seen[D_INDEX].stamp !== indexStamp) {
      tasks.push(function () {
        return publishPayload(ctx, D_INDEX, index, indexStamp).then(function () {
          ctx.account.feedIds = unique(idsFromIndex(index));
          saveAccount();
        });
      });
    }
    // One at a time, so a signer extension or bunker isn't flooded with requests.
    return tasks.reduce(function (p, task) { return p.then(task); }, Promise.resolve());
  }

  function schedule(delay) {
    if (!account || paused) return;
    clearTimeout(timer);
    timer = setTimeout(function () { run('merge').catch(noop); }, delay);
  }

  /** Forget the account on this device (in memory; the caller decides about storage). */
  function forget() {
    generation++;
    clearTimeout(timer);
    rerun = false;
    if (signer && signer.close) signer.close().catch(noop);
    signer = null;
    account = null;
  }

  function connect(next, firstSigner) {
    forget();
    paused = false;
    next.seen = {};
    next.feedIds = [];
    next.relays = next.relays || DEFAULT_RELAYS.slice();
    account = next;
    signer = firstSigner || null;
    saveAccount();
    // On a fresh device, take the synced data as-is instead of adding an empty feed to it.
    var mode = store.isPristine() ? 'pull' : 'merge';
    return (running || Promise.resolve()).then(noop, noop).then(function () { return run(mode); });
  }

  // --- public API -----------------------------------------------------------

  function getStatus() {
    return {
      state: status.state,
      message: status.message,
      connected: !!account,
      method: account ? account.method : null,
      npub: account ? NT.nip19.npubEncode(account.pubkey) : null,
      lastSyncedAt: account ? account.lastSyncedAt || null : null,
      relays: relays().slice()
    };
  }

  var Sync = {
    DEFAULT_RELAYS: DEFAULT_RELAYS,
    ACCOUNT_KEY: ACCOUNT_KEY,

    init: function () {
      if (!NT) return;
      loadAccount();
      if (account) setStatus('idle');
      store.subscribe(function (meta) {
        if (meta.synced || meta.external || meta.reset || meta.navigation) return;
        schedule(AUTO_SYNC_DELAY);
      });
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') schedule(0);
      });
      setInterval(function () {
        if (document.visibilityState === 'visible' && !running) schedule(0);
      }, POLL_INTERVAL);
      // Follow sign-ins and sign-outs made in another open tab of the app.
      global.addEventListener('storage', function (e) {
        if (e.key !== ACCOUNT_KEY && e.key !== null) return;
        var next = parseAccount(e.key === null ? null : e.newValue);
        if (!next) {
          if (account) { forget(); setStatus('off'); }
        } else if (!account || next.pubkey !== account.pubkey || next.method !== account.method) {
          forget();
          account = next;
          setStatus('idle');
          schedule(500);
        } else {
          account.relays = next.relays;
          emit();
        }
      });
      schedule(300);
    },

    available: function () { return !!NT; },
    subscribe: function (fn) { listeners.push(fn); },
    status: getStatus,

    /** Make a brand-new key. Nothing is saved until `useKey` is called with it. */
    generateKey: function () {
      var sk = NT.generateSecretKey();
      return { nsec: NT.nip19.nsecEncode(sk), npub: NT.nip19.npubEncode(NT.getPublicKey(sk)) };
    },

    /** Start syncing with a secret key (nsec1… or 64-char hex). */
    useKey: function (input) {
      var value = String(input || '').trim();
      var skHex;
      if (/^[0-9a-f]{64}$/i.test(value)) skHex = value.toLowerCase();
      else {
        var decoded;
        try { decoded = NT.nip19.decode(value); } catch (err) { decoded = null; }
        if (!decoded || decoded.type !== 'nsec') {
          return Promise.reject(new Error('That doesn’t look like a sync key. It should start with “nsec1”.'));
        }
        skHex = bytesToHex(decoded.data);
      }
      var s;
      try { s = localSigner(skHex); } catch (err) {
        return Promise.reject(new Error('That sync key isn’t valid.'));
      }
      return connect({ method: 'key', sk: skHex, pubkey: s.pubkey }, s);
    },

    hasExtension: function () { return !!global.nostr; },

    useExtension: function () {
      var ext = global.nostr;
      if (!ext) return Promise.reject(new Error('No Nostr browser extension was found. Install or unlock one, then try again.'));
      return Promise.resolve(ext.getPublicKey()).then(function (pubkey) {
        if (!isPubkey(pubkey)) throw new Error('Your Nostr extension returned an invalid public key.');
        var s = extensionSigner(pubkey);
        return connect({ method: 'extension', pubkey: pubkey }, s);
      });
    },

    useBunker: function (input) {
      var clientSk = NT.generateSecretKey();
      var bs;
      return NT.parseBunkerInput(String(input || '').trim()).then(function (pointer) {
        if (!pointer) throw new Error('That doesn’t look like a bunker address. It should start with “bunker://”.');
        bs = NT.BunkerSigner.fromBunker(clientSk, pointer, { pool: getPool(), onauth: openAuthUrl });
        return withTimeout(bs.connect(), 60000, 'The bunker didn’t respond. Check that it’s online and approve the connection there.')
          .then(function () { return bs.getPublicKey(); })
          .then(function (pubkey) {
            if (!isPubkey(pubkey)) throw new Error('The bunker returned an invalid public key.');
            return connect({ method: 'bunker', pubkey: pubkey, bunker: { pointer: pointer, clientSk: bytesToHex(clientSk) } },
              wrapBunker(bs, pubkey));
          });
      }).catch(function (err) {
        if (bs && !(account && account.method === 'bunker')) bs.close().catch(noop);
        throw err;
      });
    },

    /** The nsec for a key-based account, so the user can copy it to another device. */
    getKey: function () {
      return account && account.method === 'key' ? NT.nip19.nsecEncode(hexToBytes(account.sk)) : null;
    },

    syncNow: function () { return run('merge'); },

    /** Replace local data with the synced copy. */
    pull: function () { return run('pull'); },

    setRelays: function (list) {
      if (!account) return;
      var clean = unique(list.map(function (r) { return r.trim(); }).filter(function (r) {
        // Plain ws:// only for relays on this machine; anything else must use TLS.
        return /^wss:\/\/[^\s/]+/.test(r) || /^ws:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/\S*)?$/.test(r);
      }));
      account.relays = clean.length ? clean : DEFAULT_RELAYS.slice();
      account.seen = {}; // new relays may not have everything: re-check all events
      saveAccount();
      emit();
      schedule(0);
    },

    /** Stop syncing on this device. Local data and synced data are both kept. */
    signOut: function () {
      forget();
      paused = false;
      saveAccount();
      setStatus('off');
    },

    /**
     * Erase this app's data from the relays (an empty replacement for every
     * event plus a NIP-09 deletion request), then sign out on this device.
     */
    deleteRemote: function () {
      if (!account) return Promise.resolve();
      // Stop automatic syncs and let any in-flight one finish first, so nothing
      // is re-uploaded after the deletion.
      paused = true;
      clearTimeout(timer);
      rerun = false;
      var ctx;
      return (running || Promise.resolve()).then(noop, noop).then(function () {
        if (!account) throw new Error('Sync isn’t set up.');
        setStatus('syncing');
        ctx = context();
        return query(ctx.signer.pubkey, [D_INDEX]);
      }).then(function (latest) {
        var ev = latest[D_INDEX];
        return ev ? open(ctx.signer, ev) : null;
      }).then(function (index) {
        ctx.account.feedIds = unique(ctx.account.feedIds.concat(idsFromIndex(index)));
        return query(ctx.signer.pubkey, [D_INDEX].concat(knownFeedDs(ctx.account)));
      }).then(function (latest) {
        var ds = Object.keys(latest);
        if (!ds.length) return null;
        var t = nowSeconds();
        var chain = ds.reduce(function (p, d) {
          return p.then(function () {
            ctx.check();
            return publishEvent(ctx.signer, { kind: KIND, created_at: Math.max(t, latest[d].created_at + 1), tags: [['d', d]], content: '' });
          });
        }, Promise.resolve());
        return chain.then(function () {
          ctx.check();
          return publishEvent(ctx.signer, {
            kind: 5, created_at: nowSeconds(), content: '',
            tags: ds.map(function (d) { return ['a', KIND + ':' + ctx.signer.pubkey + ':' + d]; }).concat([['k', String(KIND)]])
          });
        });
      }).then(function () {
        Sync.signOut();
      }, function (err) {
        paused = false;
        if (err === CANCELLED) return;
        setStatus('error', (err && err.message) || 'Deleting synced data failed.');
        throw err;
      });
    }
  };

  global.FT = global.FT || {};
  global.FT.sync = Sync;
})(window);
