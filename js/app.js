/*
 * Feed Tool — rendering and UI behaviour.
 *
 * Data never reaches the page as HTML: everything is built with DOM methods
 * and set through textContent / value.
 */
(function (global) {
  'use strict';

  var store = global.FT.store;
  var rss = global.FT.rss;
  var sync = global.FT.sync;

  var $ = function (id) { return document.getElementById(id); };
  var itemsEl = $('items');
  var expanded = new Set(); // ids of items open for editing

  /** Tiny element builder: h('div', { class: 'x', text: 'hi' }, [children]). */
  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k];
      if (v === false || v == null) return;
      if (k === 'text') el.textContent = v;
      else if (k === 'value') el.value = v;
      else if (k === 'hidden') el.hidden = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    (children || []).forEach(function (c) { if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var ICONS = {
    trash: ['M4 6h12M8 6V4h4v2M5.5 6l.8 10h7.4l.8-10'],
    chevron: ['m7 5 5 5-5 5'],
    clock: ['M10 6v4l2.5 2', 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14z']
  };
  function icon(name) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('aria-hidden', 'true');
    ICONS[name].forEach(function (d) {
      var p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
    return svg;
  }

  function isTyping(el) {
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  }

  // ---------------------------------------------------------------------------
  // Rendering

  function render(meta) {
    meta = meta || {};
    var feed = store.activeFeed();
    renderFeedSelect(feed);
    renderChannel(feed);
    if (meta.local) updateItemHeads(feed);
    else renderItems(feed);
    renderPreview(feed);
    $('undo-btn').disabled = !store.canUndo();
    $('redo-btn').disabled = !store.canRedo();
    document.title = (feed.channel.title || 'Untitled feed') + ' — Feed Tool';
  }

  function renderFeedSelect(feed) {
    var select = $('feed-select');
    var feeds = store.getDb().feeds;
    select.textContent = '';
    feeds.forEach(function (f) {
      select.appendChild(h('option', { value: f.id, text: f.channel.title || 'Untitled feed' }));
    });
    select.value = feed.id;
    $('feed-delete').disabled = feeds.length === 1 && store.isPristine();
  }

  function setValue(el, value) {
    if (document.activeElement !== el && el.value !== value) el.value = value;
  }

  function renderChannel(feed) {
    setValue($('channel-title'), feed.channel.title);
    setValue($('channel-description'), feed.channel.description);
    setValue($('channel-link'), feed.channel.link);
    setValue($('feed-filename'), feed.fileName);
    setValue($('feed-timezone'), feed.timezone);
    var n = feed.channel.extra.length;
    $('channel-extra').hidden = !n;
    $('channel-extra').textContent = n
      ? n + ' other channel element' + (n === 1 ? ' was' : 's were') + ' found in the uploaded feed. ' +
        (n === 1 ? 'It’s' : 'They’re') + ' kept as written; you can see ' + (n === 1 ? 'it' : 'them') + ' in the preview.'
      : '';
  }

  function hostOf(link) {
    try { return new URL(link).host; } catch (err) { return link; }
  }

  function headText(item) {
    var pub = rss.itemPubDate(item);
    return {
      title: item.title || item.description || 'Untitled item',
      untitled: !item.title,
      meta: [pub || 'No date', item.link ? hostOf(item.link) : 'No link'].join(' · ')
    };
  }

  function field(label, input, hint) {
    return h('label', { class: 'field' }, [
      h('span', { class: 'field-label' }, [label, hint ? h('span', { class: 'field-hint', text: hint }) : null]),
      input
    ]);
  }

  function itemCard(feed, item, index) {
    var open = expanded.has(item.id);
    var bodyId = 'item-body-' + item.id;
    var head = headText(item);

    var toggle = h('button', {
      type: 'button', class: 'item-toggle', 'data-action': 'toggle',
      'aria-expanded': open ? 'true' : 'false', 'aria-controls': bodyId
    }, [
      icon('chevron'),
      h('span', { class: 'item-num', text: String(index + 1) }),
      h('span', { class: 'item-head-text' }, [
        h('span', { class: 'item-title' + (head.untitled ? ' is-untitled' : ''), text: head.title }),
        h('span', { class: 'item-meta', text: head.meta })
      ])
    ]);

    var actions = h('div', { class: 'item-actions' }, [
      h('button', { type: 'button', class: 'icon-btn icon-btn-danger', 'data-action': 'delete', title: 'Delete item', 'aria-label': 'Delete item' }, [icon('trash')])
    ]);

    var body = h('div', { class: 'item-body', id: bodyId, hidden: !open });
    if (open) {
      body.appendChild(field('Title', h('input', { type: 'text', 'data-field': 'title', value: item.title, autocomplete: 'off' })));
      body.appendChild(field('Link', h('input', { type: 'url', 'data-field': 'link', value: item.link, autocomplete: 'off', placeholder: 'https://' })));
      var desc = h('textarea', { 'data-field': 'description', rows: '2' });
      desc.value = item.description;
      body.appendChild(field('Description', desc));
      body.appendChild(h('div', { class: 'field-row' }, [
        field('Date', h('input', { type: 'datetime-local', step: '1', 'data-field': 'date', value: item.date })),
        h('label', { class: 'field field-tz' }, [
          h('span', { class: 'field-label', text: 'Zone' }),
          h('input', { type: 'text', 'data-field': 'tz', value: item.tz, maxlength: '5', autocomplete: 'off', spellcheck: 'false' })
        ]),
        h('button', { type: 'button', class: 'btn btn-small now-btn', 'data-action': 'now', title: 'Set to the current time' }, [icon('clock'), 'Now'])
      ]));
      if (!item.date && item.rawDate) {
        body.appendChild(h('p', { class: 'panel-note', text: 'The uploaded date “' + item.rawDate + '” couldn’t be read, so it’s written exactly as it was. Pick a date to replace it.' }));
      }
      if (item.extra.length) {
        body.appendChild(h('p', { class: 'panel-note', text: item.extra.length + ' other element' + (item.extra.length === 1 ? '' : 's') + ' from the uploaded feed ' + (item.extra.length === 1 ? 'is' : 'are') + ' kept as written.' }));
      }
      autosize(desc);
    }

    return h('div', { class: 'item' + (open ? ' is-open' : ''), role: 'listitem', 'data-item-id': item.id }, [
      h('div', { class: 'item-head' }, [toggle, actions]),
      body
    ]);
  }

  function renderItems(feed) {
    // Keep focus (and the caret) on the same field or button across a rebuild.
    var active = document.activeElement;
    var keep = null;
    if (active && itemsEl.contains(active)) {
      var card = active.closest('[data-item-id]');
      keep = {
        id: card && card.getAttribute('data-item-id'),
        sel: active.hasAttribute('data-field') ? '[data-field="' + active.getAttribute('data-field') + '"]'
          : active.hasAttribute('data-action') ? '[data-action="' + active.getAttribute('data-action') + '"]' : null,
        start: active.selectionStart, end: active.selectionEnd
      };
    }

    var ids = new Set(feed.items.map(function (it) { return it.id; }));
    expanded.forEach(function (id) { if (!ids.has(id)) expanded.delete(id); });

    reorderPending = false;
    itemsEl.textContent = '';
    feed.items.forEach(function (item, i) { itemsEl.appendChild(itemCard(feed, item, i)); });
    $('items-empty').hidden = feed.items.length > 0;
    $('items-count').textContent = feed.items.length ? String(feed.items.length) : '';
    $('items-toggle-all').hidden = !feed.items.length;
    $('items-toggle-all').textContent = feed.items.length && expanded.size === feed.items.length ? 'Collapse all' : 'Expand all';

    if (keep && keep.id && keep.sel) {
      var cardEl = itemsEl.querySelector('[data-item-id="' + keep.id + '"]');
      var target = cardEl && cardEl.querySelector(keep.sel);
      if (target && !target.disabled) {
        target.focus();
        target.scrollIntoView({ block: 'nearest' });
        try { if (typeof keep.start === 'number') target.setSelectionRange(keep.start, keep.end); } catch (err) { /* not a text field */ }
      } else if (cardEl) {
        cardEl.querySelector('[data-action="toggle"]').focus();
      }
    }
  }

  /** After typing in an item, refresh just the card headers (the fields already show the text). */
  function updateItemHeads(feed) {
    feed.items.forEach(function (item) {
      var card = itemsEl.querySelector('[data-item-id="' + item.id + '"]');
      if (!card) return;
      var head = headText(item);
      var title = card.querySelector('.item-title');
      title.textContent = head.title;
      title.classList.toggle('is-untitled', head.untitled);
      card.querySelector('.item-meta').textContent = head.meta;
    });
  }

  function formatSize(bytes) {
    return bytes < 1024 ? bytes + ' B' : (bytes / 1024).toFixed(1) + ' KB';
  }

  function currentXml() { return rss.generate(store.activeFeed()); }

  function renderPreview(feed) {
    var xml = rss.generate(feed);
    $('xml').textContent = xml;
    $('preview-filename').textContent = feed.fileName;
    $('preview-size').textContent = formatSize(new TextEncoder().encode(xml).length);
  }

  function autosize(textarea) {
    requestAnimationFrame(function () {
      textarea.style.height = 'auto';
      textarea.style.height = textarea.scrollHeight + 2 + 'px';
    });
  }

  // ---------------------------------------------------------------------------
  // Toast and confirm

  var toastTimer = 0;
  function toast(text, actionLabel, action) {
    var el = $('toast');
    var btn = $('toast-action');
    $('toast-text').textContent = text;
    btn.hidden = !actionLabel;
    btn.textContent = actionLabel || '';
    btn.onclick = actionLabel ? function () { el.hidden = true; action(); } : null;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, actionLabel ? 7000 : 4000);
  }

  function confirmDialog(title, message, okLabel) {
    var dlg = $('confirm-dialog');
    $('confirm-title').textContent = title;
    $('confirm-message').textContent = message;
    $('confirm-ok').textContent = okLabel || 'Delete';
    dlg.returnValue = '';
    dlg.showModal();
    return new Promise(function (resolve) {
      dlg.addEventListener('close', function onClose() {
        dlg.removeEventListener('close', onClose);
        resolve(dlg.returnValue === 'confirm');
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Feeds and channel

  $('feed-select').addEventListener('change', function (e) {
    expanded.clear();
    store.setActiveFeed(e.target.value);
  });

  $('feed-add').addEventListener('click', function () {
    expanded.clear();
    store.addFeed();
    var title = $('channel-title');
    title.focus();
    title.select();
  });

  $('feed-delete').addEventListener('click', function () {
    var feed = store.activeFeed();
    var name = feed.channel.title || 'Untitled feed';
    confirmDialog('Delete “' + name + '”?',
      'This feed and its ' + feed.items.length + ' item' + (feed.items.length === 1 ? '' : 's') + ' will be removed from this browser' +
      (sync.status().connected ? ' and from your synced data' : '') + '. Download it first if you want a copy.', 'Delete feed')
      .then(function (ok) {
        if (!ok) return;
        store.deleteFeed(feed.id);
        toast('Feed deleted', 'Undo', function () { store.undo(); });
      });
  });

  document.querySelector('.channel').addEventListener('input', function (e) {
    var key = e.target.getAttribute('data-channel');
    if (!key) return;
    var patch = {};
    patch[key] = e.target.value;
    store.updateFeed(store.activeFeed().id, patch, { local: true, coalesce: 'channel:' + key });
  });
  // Show the cleaned-up value (file name, zone) once the field is left.
  document.querySelector('.channel').addEventListener('change', function () { renderChannel(store.activeFeed()); });

  // ---------------------------------------------------------------------------
  // Items

  $('item-add').addEventListener('click', function () {
    var feed = store.activeFeed();
    var id = store.addItem(feed.id, { date: rss.nowLocal(), tz: feed.timezone });
    expanded.add(id);
    render();
    var input = itemsEl.querySelector('[data-item-id="' + id + '"] [data-field="title"]');
    if (input) input.focus();
  });

  $('items-toggle-all').addEventListener('click', function () {
    var feed = store.activeFeed();
    if (expanded.size === feed.items.length) expanded.clear();
    else feed.items.forEach(function (it) { expanded.add(it.id); });
    render();
  });

  itemsEl.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var card = btn.closest('[data-item-id]');
    var id = card.getAttribute('data-item-id');
    var feed = store.activeFeed();
    var action = btn.getAttribute('data-action');
    if (action === 'toggle') {
      if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
      render();
    } else if (action === 'delete') {
      var item = feed.items.filter(function (it) { return it.id === id; })[0];
      store.deleteItem(feed.id, id);
      toast('Deleted “' + (item && item.title || 'Untitled item') + '”', 'Undo', function () { store.undo(); });
    } else if (action === 'now') {
      store.updateItem(feed.id, id, { date: rss.nowLocal() });
    }
  });

  itemsEl.addEventListener('input', function (e) {
    var key = e.target.getAttribute('data-field');
    if (!key) return;
    var id = e.target.closest('[data-item-id]').getAttribute('data-item-id');
    var patch = {};
    patch[key] = e.target.value;
    store.updateItem(store.activeFeed().id, id, patch, { local: true, coalesce: id + ':' + key });
    if (e.target.tagName === 'TEXTAREA') autosize(e.target);
  });
  itemsEl.addEventListener('change', function (e) {
    if (e.target.getAttribute('data-field') === 'tz') render();
  });

  // Items are always shown newest first. A card whose date was edited moves to
  // its new place once the date field is left, not while it's being typed in.
  // If that happens during a click, wait for the click to land first.
  var reorderPending = false;
  var pointerDown = false;

  function cardsOutOfOrder() {
    var shown = Array.prototype.map.call(itemsEl.querySelectorAll('[data-item-id]'), function (el) { return el.getAttribute('data-item-id'); });
    return shown.join() !== store.activeFeed().items.map(function (it) { return it.id; }).join();
  }
  function applyReorder() {
    if (reorderPending && !pointerDown) render();
  }

  itemsEl.addEventListener('focusout', function (e) {
    if (e.target.getAttribute('data-field') !== 'date' || !cardsOutOfOrder()) return;
    reorderPending = true;
    setTimeout(applyReorder, 0);
  });
  document.addEventListener('pointerdown', function () { pointerDown = true; }, true);
  document.addEventListener('pointerup', function () {
    pointerDown = false;
    if (reorderPending) setTimeout(applyReorder, 0);
  }, true);

  // ---------------------------------------------------------------------------
  // Upload, copy, download

  function readFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onerror = function () { toast('That file couldn’t be read.'); };
    reader.onload = function () {
      var parsed;
      try { parsed = rss.parse(reader.result); } catch (err) {
        toast(err.message);
        return;
      }
      parsed.fileName = file.name;
      expanded.clear();
      store.importFeed(parsed);
      var n = parsed.items.length;
      var tidied = parsed.items.filter(function (it) { return it.date && it.originalDate !== rss.itemPubDate(it); }).length;
      toast('Uploaded “' + (parsed.channel.title || file.name) + '” with ' + n + ' item' + (n === 1 ? '' : 's') + '.' +
        (tidied ? ' ' + tidied + ' date' + (tidied === 1 ? ' was' : 's were') + ' tidied (weekday or month spelling).' : ''));
    };
    reader.readAsText(file);
  }

  $('upload-btn').addEventListener('click', function () { $('upload-file').click(); });
  $('upload-file').addEventListener('change', function (e) {
    readFile(e.target.files[0]);
    e.target.value = '';
  });

  // Drag a file anywhere onto the page to upload it.
  var dragDepth = 0;
  function hasFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') >= 0; }
  document.addEventListener('dragenter', function (e) {
    if (!hasFiles(e)) return;
    dragDepth++;
    $('drop-overlay').hidden = false;
  });
  document.addEventListener('dragleave', function (e) {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('drop-overlay').hidden = true;
  });
  document.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('drop-overlay').hidden = true;
    readFile(e.dataTransfer.files[0]);
  });

  $('copy-xml').addEventListener('click', function (e) {
    var btn = e.currentTarget;
    var done = function () {
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(currentXml()).then(done, function () { selectPreview(); });
    } else {
      selectPreview();
      try { if (document.execCommand('copy')) done(); } catch (err) { /* left selected */ }
    }
  });

  function selectPreview() {
    var range = document.createRange();
    range.selectNodeContents($('xml'));
    var sel = global.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  $('download-xml').addEventListener('click', function () {
    var feed = store.activeFeed();
    var blob = new Blob([rss.generate(feed)], { type: 'application/rss+xml' });
    var url = URL.createObjectURL(blob);
    var a = h('a', { href: url, download: feed.fileName });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });

  // ---------------------------------------------------------------------------
  // Undo / redo

  $('undo-btn').addEventListener('click', function () { store.undo(); });
  $('redo-btn').addEventListener('click', function () { store.redo(); });

  document.addEventListener('keydown', function (e) {
    if (!(e.ctrlKey || e.metaKey) || isTyping(document.activeElement) || document.querySelector('dialog[open]')) return;
    var k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); store.undo(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); store.redo(); }
  });

  // ---------------------------------------------------------------------------
  // Dialogs

  // Close buttons, and clicking the backdrop, close any of the popups.
  document.querySelectorAll('dialog').forEach(function (dlg) {
    dlg.addEventListener('click', function (e) {
      if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
    });
  });

  // "Copy" buttons next to key fields.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-copy]');
    if (!btn) return;
    var input = $(btn.getAttribute('data-copy'));
    var done = function () {
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(input.value).then(done, function () { input.select(); });
    } else {
      input.select();
      try { document.execCommand('copy'); done(); } catch (err) { /* leave it selected */ }
    }
  });

  /** Run an async action with `button` disabled and showing `busyLabel`. */
  function busy(button, busyLabel, promise) {
    var children = Array.prototype.slice.call(button.childNodes);
    button.disabled = true;
    if (busyLabel) button.textContent = busyLabel;
    return promise.finally(function () {
      button.disabled = false;
      button.textContent = '';
      children.forEach(function (c) { button.appendChild(c); });
    });
  }

  function timeAgo(iso) {
    if (!iso) return 'never';
    var s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 45) return 'just now';
    if (s < 90) return 'a minute ago';
    if (s < 3600) return Math.round(s / 60) + ' minutes ago';
    if (s < 5400) return 'an hour ago';
    if (s < 86400) return Math.round(s / 3600) + ' hours ago';
    return new Date(iso).toLocaleString();
  }

  // ---------------------------------------------------------------------------
  // Sync

  var syncDialog = $('sync-dialog');
  var METHOD_LABELS = { key: 'Sync key', extension: 'Browser extension', bunker: 'nsec bunker' };

  function renderSyncButton() {
    var st = sync.status();
    var label = 'Sync';
    var title = 'Sync your feeds across devices';
    var state = 'off';
    if (store.saveError()) {
      label = 'Not saved';
      title = 'This browser refused to save your feeds. Download a copy to be safe.';
      state = 'error';
    } else if (st.connected) {
      state = st.state;
      if (st.state === 'syncing') label = 'Syncing…';
      else if (st.state === 'error') { label = 'Sync problem'; title = st.message; }
      else if (st.lastSyncedAt) { label = 'Synced'; title = 'Last synced ' + timeAgo(st.lastSyncedAt); }
      else label = 'Sync on';
    }
    $('sync-btn-label').textContent = label;
    $('sync-btn').title = title;
    $('sync-btn-dot').dataset.state = state;
  }

  function openSyncDialog() {
    showSyncError('');
    $('sync-generated').hidden = true;
    $('sync-generated-key').value = '';
    $('sync-key-input').value = '';
    $('sync-key-reveal').hidden = true;
    $('sync-key-value').value = '';
    renderSyncDialog();
    $('sync-relays').value = sync.status().relays.join('\n');
    if (!syncDialog.open) syncDialog.showModal();
  }

  syncDialog.addEventListener('close', function () {
    ['sync-generated-key', 'sync-key-input', 'sync-key-value'].forEach(function (id) { $(id).value = ''; });
    $('sync-generated').hidden = true;
    $('sync-key-reveal').hidden = true;
  });

  function showSyncError(message) {
    var el = $('sync-error');
    el.textContent = message;
    el.hidden = !message;
  }

  function renderSyncDialog() {
    var st = sync.status();
    $('sync-signed-out').hidden = st.connected;
    $('sync-signed-in').hidden = !st.connected;
    if (!st.connected) return;
    var titles = { syncing: 'Syncing…', synced: 'Synced', error: 'Sync problem', idle: 'Sync on' };
    $('sync-state-title').textContent = titles[st.state] || 'Sync on';
    $('sync-state-detail').textContent = st.state === 'error' ? st.message : 'Last synced ' + timeAgo(st.lastSyncedAt) + '.';
    $('sync-dot').dataset.state = st.state;
    $('sync-method').textContent = METHOD_LABELS[st.method] || st.method;
    $('sync-npub').textContent = st.npub.slice(0, 16) + '…' + st.npub.slice(-6);
    $('sync-npub').title = st.npub;
    $('sync-show-key').hidden = st.method !== 'key';
    $('sync-now').disabled = st.state === 'syncing';
  }

  sync.subscribe(function () {
    renderSyncButton();
    if (syncDialog.open) renderSyncDialog();
  });

  $('sync-btn').addEventListener('click', function () {
    if (!sync.available()) {
      toast('Sync isn’t available: the Nostr library failed to load.');
      return;
    }
    openSyncDialog();
  });

  /** Shared handling for the three ways of turning sync on. */
  function startSync(button, label, promiseFn) {
    showSyncError('');
    var p;
    try { p = promiseFn(); } catch (err) { p = Promise.reject(err); }
    return busy(button, label, p).then(function () {
      renderSyncDialog();
      toast('Sync is on');
    }, function (err) {
      renderSyncDialog();
      showSyncError(err && err.message ? err.message : 'Couldn’t start syncing.');
    });
  }

  $('sync-generate').addEventListener('click', function () {
    var key = sync.generateKey();
    $('sync-generated-key').value = key.nsec;
    $('sync-generated').hidden = false;
    $('sync-generated-key').select();
  });

  $('sync-generated-use').addEventListener('click', function (e) {
    var nsec = $('sync-generated-key').value;
    startSync(e.currentTarget, 'Starting…', function () { return sync.useKey(nsec); });
  });

  $('sync-key-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var value = $('sync-key-input').value;
    if (!value.trim()) { $('sync-key-input').focus(); return; }
    startSync(e.currentTarget.querySelector('button'), 'Connecting…', function () { return sync.useKey(value); })
      .then(function () { $('sync-key-input').value = ''; });
  });

  $('sync-extension').addEventListener('click', function (e) {
    startSync(e.currentTarget, 'Waiting for extension…', function () { return sync.useExtension(); });
  });

  $('sync-bunker-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var value = $('sync-bunker-input').value;
    if (!value.trim()) { $('sync-bunker-input').focus(); return; }
    startSync(e.currentTarget.querySelector('button'), 'Waiting for bunker…', function () { return sync.useBunker(value); });
  });

  $('sync-now').addEventListener('click', function (e) {
    showSyncError('');
    busy(e.currentTarget, 'Syncing…', sync.syncNow()).catch(function () { /* shown in the status */ });
  });

  $('sync-show-key').addEventListener('click', function () {
    var reveal = $('sync-key-reveal');
    reveal.hidden = !reveal.hidden;
    $('sync-key-value').value = reveal.hidden ? '' : sync.getKey();
  });

  $('sync-signout').addEventListener('click', function () {
    var msg = 'This device will stop syncing. Your feeds stay in this browser, and your synced data stays on the relays.';
    if (sync.status().method === 'key') msg += ' To sync again you’ll need your sync key, so make sure it’s saved.';
    confirmDialog('Stop syncing?', msg, 'Stop syncing').then(function (ok) {
      if (!ok) return;
      sync.signOut();
      openSyncDialog();
    });
  });

  $('sync-delete').addEventListener('click', function (e) {
    var button = e.currentTarget;
    confirmDialog('Delete synced data?', 'Your feeds will be erased from the relays and this device will stop syncing. Feeds in this browser are kept. This can’t be undone.', 'Delete')
      .then(function (ok) {
        if (!ok) return;
        busy(button, 'Deleting…', sync.deleteRemote()).then(function () {
          openSyncDialog();
          toast('Synced data deleted. This device has stopped syncing.');
        }, function (err) {
          showSyncError((err && err.message) || 'Deleting synced data failed.');
        });
      });
  });

  $('sync-relays-save').addEventListener('click', function () {
    sync.setRelays($('sync-relays').value.split(/\s+/));
    $('sync-relays').value = sync.status().relays.join('\n');
    toast('Relays saved');
  });
  $('sync-relays-reset').addEventListener('click', function () {
    $('sync-relays').value = sync.DEFAULT_RELAYS.join('\n');
  });

  // ---------------------------------------------------------------------------
  // Boot

  store.init();
  store.subscribe(function (meta) { render(meta); renderSyncButton(); });
  if (sync.available()) sync.init();
  render();
  renderSyncButton();
  setInterval(renderSyncButton, 60 * 1000); // keep "Last synced …" fresh
})(window);
