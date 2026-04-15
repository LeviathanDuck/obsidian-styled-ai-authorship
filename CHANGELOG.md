# Changelog

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
