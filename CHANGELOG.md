# Changelog

## 0.2.5 — 2026-04-17

Default storage backend flipped from sidecar to data.json. The
single-file backend is simpler for the typical case (one user, one or
two devices, modest range counts) and avoids the visible
`z-author-sync/` folder showing up in the vault. Existing installs
keep whatever backend they already had — only fresh installs get the
new default.

The settings UI now explains both options on the dropdown and in the
data.json info panel: data.json is the default, but the Sidecar
folder option is preferable if you have hundreds-to-thousands of
notes with AI styling **and** multiple devices editing
simultaneously. In that scenario the per-note partitioning of
sidecars prevents the whole-file overwrite that data.json is
vulnerable to.

## 0.2.0 — 2026-04-17

Major storage iteration. Authorship records now use an event-sourced
schema with per-event timestamps and device IDs, enabling correct
last-write-wins resolution when two devices edit the same note while
offline. Sync-conflict files (Syncthing, iCloud, Dropbox, OneDrive,
Obsidian Sync) are detected and merged automatically. Schema is
forward-compatible with the planned multi-author features (Human 1,
Human 2, AI 2, etc.) — every event carries an `author` field that v0.2
defaults to `"ai"`.

### Added

- **Storage backend selection** — choose between sidecar folder
  (recommended; one JSON file per note) and a single `data.json` file.
  The sidecar folder remains the default.
- **Event log + snapshot schema (v2)** — every range mutation appends a
  `{op, author, from, to, ts, dev, id}` event. On load, events are
  folded onto the snapshot in `(ts, id)` order to produce the current
  range set. Periodic compaction folds events older than the safety
  window into the snapshot.
- **Sync conflict detection and merge** — `ConflictScanner` recognizes
  Syncthing `.sync-conflict-*`, iCloud `* 2.json`, Dropbox
  `(conflicted copy)`, OneDrive `-DEVICENAME.json`, and Obsidian Sync
  `.conflict.json` filename patterns. On a hit, both files are parsed
  and verified, merged by event union + dedup, and the conflict copy
  is removed. Runs on plugin load, when the window regains focus, and
  via a manual "Rescan conflicts" button in settings.
- **Device ID** — generated on first run, embedded in every event.
  Visible in settings with a Regenerate button for vault clones.
- **3.8 MB sync-safe cap** — Obsidian Sync caps individual files at
  5 MB. The plugin enforces a 3.8 MB cap on each record. When a write
  would exceed it, aggressive compaction runs first; if still over,
  the write is refused with a Notice rather than risking sync failure.
  A one-time per-session warning fires at ~84% of cap.
- **Cache size display + delete-cache button** — the Data storage
  settings section shows current usage. The Delete cache button opens
  a confirmation modal that requires typing `DELETE` (case-insensitive)
  before destroying all stored authorship records.

### Changed

- **In-memory `AIRange` gains an optional `author` field.** v0.2 always
  uses `"ai"`; v0.3+ will populate other authors. Range helpers
  (`mergeRange`, `subtractInterval`, `normalizeRanges`, `sameRanges`)
  are author-aware: same-author ranges merge, cross-author never do.
- **Sidecar I/O moved into `StorageBackend` abstraction.** `main.ts`
  no longer talks to the adapter directly for authorship records.
  Two backends ship: `SidecarStorage` and `DataJsonStorage`.
- **v1 → v2 migration** runs lazily on first load of each note. The
  v1 `ranges` array is upgraded to a v2 snapshot using the file's
  mtime as the snapshot timestamp; the v2 record is written back on
  the next mutation.

### Architectural

- Pure-TS schema and helpers in `src/schema.ts` (no Obsidian imports);
  storage backends in `src/storage.ts`; conflict scanner in
  `src/conflict.ts`. `main.ts` is the integration layer.

## 0.1.1 — 2026-04-15

First feature-complete release. The plugin now covers the full workflow: paste
AI-authored text with a gradient marker, edit to reclaim authorship, and
persist authorship across sessions and devices.

### Added

- **Paste with AI Style** command and right-click menu item — pastes clipboard
  contents with the gradient applied.
- **Mark Selection as AI Style** command and menu item — converts existing
  selected text into AI-styled without re-pasting.
- **Remove AI Styling** command and menu item — strips the gradient from the
  current selection without modifying the text.
- **Sidecar persistence** — authorship metadata is stored in a `.authorship/`
  folder at the vault root, one JSON file per note. Syncs via Obsidian Sync,
  iCloud Drive, Dropbox, and any other vault sync tool.
- **Clipboard handoff** — copy/cut/paste preserves authorship across notes in
  the same vault via a custom clipboard MIME type.
- **Per-character editing behavior** — typing inside AI-styled text produces
  normal characters; the gradient fades in proportion to how much of the text
  has been edited by the user.
- **Settings tab**:
  - Gradient preset chicklets (Cascade, Sunset, Ocean, Forest, Monochrome,
    Deep Blue) with inline Reset button.
  - Individual color pickers for each of the five gradient stops.
  - Live gradient preview text that updates as you adjust colors.
  - Ribbon orientation: Vertical (default) or Horizontal (river).
  - Waviness slider (0–200%) controlling wave amplitude.
  - Per-menu-item visibility toggles.
  - Global "Show AI authorship styling" toggle.
- **Mobile support** — manifest declares `isDesktopOnly: false`; clipboard
  errors are handled gracefully with platform-aware messaging.

### Architectural

- Per-character range tracking via CodeMirror 6 `StateField` with `ChangeSet`
  mapping and explicit subtract-on-insert logic.
- Drifting-ribbon gradient algorithm with pixel-space field computation and
  viewport-aware slicing.
- Settings changes trigger an immediate refresh of all open editors without
  requiring a reload.

### Attribution

A project of the Leviathan Duck from Leftcoast Media House Inc.

Inspired by iA Writer's Authorship feature. Independent implementation; no iA
Writer code is used.

## 0.1.0

Initial scaffolding. Not released.
