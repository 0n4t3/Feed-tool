# Feed-tool
A simple, vibe coded, tool I use to manage handcrafted RSS feeds.

It's plain HTML, CSS and JavaScript, with no build step and no server. Open
`index.html` in a browser (opening it straight from disk with `file://` works),
or serve the folder with any static file server, e.g. `python3 -m http.server`.

## What it does

- **Edit a list of items.** Each item has a title, link, description and date.
  Add items with **New item** (they go at the top, dated now), reorder them with
  the arrows or **Sort by date**, and delete them (with undo).
- **Channel details:** title, description and link, plus the file name used for
  downloads and the default time zone label for new items.
- **Live preview** of the generated XML, with **Copy** and **Download**.
- **Upload an existing feed** (or drag the file onto the page) to edit it. If
  the current feed is still empty, the upload replaces it; otherwise it's added
  as a new feed. Use the picker at the top to switch between feeds.
- **Undo / redo** (Ctrl/⌘+Z, Ctrl/⌘+Shift+Z) for every change.

## Output format

The generated file follows the layout of a handwritten feed:

```xml
<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
  <channel>
    <title>Untitled Miniblog</title>
    <description>Experimental posts, random thoughts, and all manner of shenanigans</description>
    <link>https://nate.mecca1.net/miniblog/miniblog/</link>
    <!-- top of entries -->
    <item>
      <title>A vibe coding story</title>
      <link>https://…</link>
      <description>An experience developing niche software that helped me</description>
      <pubDate>Sat, 03 Oct 2026 14:31:00 EST</pubDate>
    </item>
    <!-- entry divider -->
    <item>
      …
    </item>
    <!-- bottom of entries -->
  </channel>
</rss>
```

- Dates are written exactly as entered, followed by the zone label (no time
  zone conversion). The weekday is always computed from the date, so it can't
  be wrong.
- Uploaded dates are read leniently (`Sept`, a wrong weekday, missing seconds).
  The upload message says how many were tidied up. A date that can't be read
  at all is kept exactly as written until you pick a new one.
- Repeated `<!-- entry divider -->` comments become a single one between each
  pair of items.
- Other elements in an uploaded feed (e.g. `<guid>`, `<language>`,
  `<atom:link>`) are kept as written and output after the standard ones, along
  with any extra attributes on `<rss>`.

## Storage

Everything is saved automatically to the browser's `localStorage`:

| Key | Contents |
| --- | --- |
| `feedTool.db` | Your feeds (shape described at the top of [`js/store.js`](js/store.js)) |
| `feedTool.sync` | Sync sign-in. For a sync key this includes the secret key itself |

## Sync

Sync is optional and works like the
[Story Outline Tool](https://github.com/0n4t3/story-tool)'s: it uses
[Nostr](https://nostr.org/) relays as storage and encrypts your feeds end to
end with NIP-44 before they leave the browser.

- **Generate Sync Key**, **Enter Sync Key** (`nsec1…`), or **Sign in with
  Nostr** using a NIP-07 extension (with NIP-44 support) or a NIP-46
  `bunker://` address.
- Each feed is one NIP-78 application-data event (kind `30078`, `d` tag
  `feed-tool/feed/<id>`), gzipped and encrypted to your own key. An index event
  (`feed-tool/index`) holds the feed order and the list of deleted feeds.
- Changes sync about 3 seconds after you stop editing, when the page regains
  focus, and every 90 seconds while it's visible.
- Merging works per feed: the most recently edited version wins. A deletion
  wins over edits made before it.
- Default relays are `relay.damus.io`, `nos.lol`, `relay.primal.net` and
  `offchain.pub`; you can change them in the Sync popup.
- Relays can see your public key, when you sync, that you use this app, how
  many feeds you have and roughly how large they are, but never their
  contents.

## Project layout

```
index.html       page structure and popups
css/styles.css   styles (light/dark follow the system)
js/store.js      data model, localStorage persistence, undo/redo
js/rss.js        RSS parsing and generation
js/sync.js       encrypted Nostr sync (adapted from story-tool)
js/app.js        rendering and UI behaviour
vendor/          nostr-tools build (see vendor/README.md)
```

## License

GPL-3.0. See [LICENSE](LICENSE). Vendored nostr-tools is Unlicense (its
bundled `@noble`/`@scure` dependencies are MIT).
