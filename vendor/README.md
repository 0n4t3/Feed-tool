# Vendored libraries

## nostr-tools.min.js

A browser build of [nostr-tools](https://github.com/nbd-wtf/nostr-tools)
2.25.2 (Unlicense), plus the `@noble` / `@scure` crypto libraries it depends on
(MIT). The app uses it for Nostr keys, NIP-44 encryption, relay connections and
NIP-46 remote signers. It's committed to the repo so the app keeps working
offline from `file://` with no build step.

The file only includes what [`nostr-tools.entry.js`](nostr-tools.entry.js)
exports, and exposes it as `window.NostrTools`. To rebuild it:

```sh
npm i nostr-tools@2.25.2 esbuild
npx esbuild vendor/nostr-tools.entry.js --bundle --minify --format=iife \
  --global-name=NostrTools --target=es2019 --legal-comments=eof \
  --outfile=vendor/nostr-tools.min.js
```

Then put the header comment from the current file back at the top.

