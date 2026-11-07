# Meal Plan

A lightweight dinner planner and shopping list for iPhone, built as a home-screen web app. Plan a few days of dinners in one sitting, note what you're missing, and get a running shopping list.

Plain HTML, CSS, and JavaScript. No frameworks, no build step, no server, no accounts. All data stays on the phone.

## Browser versions

- **Developed for:** Safari 27 on iOS 27 (November 2026).
- **Minimum:** Safari 15.4 on iOS 15.4, the first version with native `<dialog>`, `dvh` units, `crypto.randomUUID`, and `accent-color`, which the code relies on.

## What it does

- **Calendar**: a rolling view of today plus the next three days, with the last two days compacted above. Extend up to a week, plan further out by date, and share the plan as text.
- **Plan meals**: pick foods for each day, add a missing-items note, and edit, clear, or move a whole day.
- **Food**: your catalog of dishes, with tags, search, and a tag filter.
- **Shopping**: a de-duplicated list built from the day notes for today onward, plus items added directly.

## Install on iPhone

1. Open the site in Safari: `https://<your-site>.netlify.app`
2. Tap **Share**, then **Add to Home Screen**.
3. Open it from the home screen icon. After the first load it works offline.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page structure: three tabs and the dialogs |
| `styles.css` | All styling; colors are tokens with a dark-mode set |
| `app.js` | All behavior and data handling |
| `sw.js` | Service worker: caches the app for instant, offline launches |
| `manifest.webmanifest` | Home-screen name, icon, and full-screen display |
| `icons/` | App icons (192, 512, and Apple touch icon) |
| `netlify.toml` | Netlify settings: no build step, and `sw.js` is never cached |

## Data model

Stored in IndexedDB (database `meal-plan`) on the device:

- `foods`: `{ id, name, tags: [] }`
- `plans`: `{ date: "YYYY-MM-DD", foodIds: [], note }`, one record per planned day
- `meta`: `{ key: "shoppingExtras", items: [] }` and `{ key: "tagCounts", counts: {} }`

The shopping list isn't stored on its own; it's computed from the `note` on today's and later plans, plus `shoppingExtras`.

## Backup and restore

Data lives only on the phone and is lost if Safari's website data is cleared or the phone is replaced. On the **Food** tab:

- **Export backup** saves everything as a JSON file (Save to Files or iCloud Drive).
- **Import backup** replaces the data on this phone with a backup file.

Saved data is tied to the site's address, so moving to a different domain means exporting first and importing on the new one.

## Shipping an update

1. Edit the files and commit to `main`. Netlify deploys automatically.
2. **Bump `VERSION` in `sw.js`** (for example `v2` to `v3`) with every release. This is how phones notice the update. Without it, they keep running the cached copy.
3. On the phone, the new version downloads in the background and is used from the next launch.

If a new release changes the database shape, raise `DB_VERSION` in `app.js` and add the change inside `onupgradeneeded` so existing data carries over.

## Run locally

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000`. The service worker also runs on localhost.

## Other browsers and Android

The app is built and tested for Safari on iPhone, but it uses standard web features, so it runs elsewhere with little or no change. Things to keep in mind when adapting it:

- **Installing:** Chrome, Edge, and Samsung Internet install from `manifest.webmanifest` ("Install app" or "Add to Home screen"). The `apple-*` meta tags in `index.html` are Safari-only and harmless elsewhere. Firefox on Android adds a home-screen shortcut; desktop Firefox doesn't install web apps at all.
- **Android icon:** Android crops icons into circles and other shapes. The manifest currently reuses `icon-512.png` as the `maskable` icon, so edge details (the fork and knife) can be clipped. Make a separate maskable icon with the artwork inside the center 80% and point the `"purpose": "maskable"` entry at it.
- **Text size:** `font: -apple-system-body` in `styles.css` follows iPhone's Text Size setting and is ignored by other browsers, which fall back to `font-size: 100%` and the browser's own text-size setting. Change that fallback if you want a different base size.
- **Sharing and backups:** Share plan and Export backup use the Web Share API. Where it's missing (desktop Firefox, some desktop browsers), Share copies the plan to the clipboard and Export downloads the file instead. Both fallbacks are in `app.js`.
- **Date picker:** "Plan a later date" uses `<input type="date">`, which looks different in each browser but works in all current ones.
- **Storage:** browsers may clear site data under storage pressure, and Safari can clear it for sites unused for weeks. Consider calling `navigator.storage.persist()` at startup to ask the browser to keep the data, and keep exporting backups.
- **Status bar color:** the `theme-color` meta tags in `index.html` tint the browser or status bar in Chrome on Android. Adjust them if you change the palette.
- **HTTPS:** service workers only run over HTTPS or on `localhost`, so offline mode won't work from a plain `http://` address or an opened file.

## License

This project uses the most permissive license available: [The Unlicense](https://unlicense.org), which places the code in the public domain. Anyone may copy, modify, publish, use, sell, or distribute it, for any purpose, with no attribution and no conditions. Keep any third-party additions under licenses at least this permissive, or note them separately.

## Accessibility

Built to WCAG 2.2 AA: labeled controls for VoiceOver, 44px touch targets, AA contrast in light and dark mode, support for iPhone's text size setting, and respect for Reduce Motion.
