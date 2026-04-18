import {
  AbstractInputSuggest,
  App,
  Editor,
  MarkdownView,
  Menu,
  Modal,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  debounce,
  normalizePath,
  prepareFuzzySearch,
  renderMatches,
} from "obsidian";
import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";

import {
  AIRange,
  DATA_JSON_SIZE_CAP_BYTES,
  DATA_JSON_WARN_THRESHOLD,
  DEFAULT_AUTHOR,
  RangeEvent,
  authorOf,
  diffRangeSets,
  generateDeviceId,
  mergeRange,
  normalizeRanges,
  sameRanges,
  subtractInterval,
} from "./src/schema";
import {
  CacheSize,
  DataJsonStorage,
  SidecarStorage,
  StorageBackend,
  encodeSidecarPath,
} from "./src/storage";
import { ConflictScanner } from "./src/conflict";

export type { AIRange };


interface RGB {
  r: number;
  g: number;
  b: number;
}

interface Stop {
  pos: number;
  rgb: RGB;
}

interface GradientField {
  baseCenterX: number;
  baseCenterY: number;
  rangeTop: number;
  rangeBottom: number;
  horizontalRadius: number;
  verticalRadius: number;
  fieldLeft: number;
  fieldSpan: number;
  contentLeft: number;
  charWidth: number;
  waveAmplitude: number;
  wavePeriod: number;
}

interface GradientConfig {
  stops: Stop[];
  orientation: GradientOrientation;
  waviness: number;
  debug: boolean;
}

// ---- settings ----

type GradientOrientation = "vertical" | "horizontal";

interface AuthorshipSettings {
  showAIStyling: boolean;
  showPasteMenuItem: boolean;
  showMarkSelectionMenuItem: boolean;
  showRemoveMenuItem: boolean;
  gradientStops: string[];
  orientation: GradientOrientation;
  waviness: number; // 0.0 = flat, 1.0 = default, 2.0 = strong
  showInReadingMode: boolean;
  debug: boolean;
  // Vault-relative path for the sidecar folder. Defaults to SIDECAR_FOLDER.
  sidecarFolderPath: string;
  // Previous path stashed when the user changes sidecarFolderPath, so the
  // "Migrate data now" button and the load-time backstop know where old
  // data lives. null when there is nothing to migrate.
  previousSidecarFolderPath: string | null;
  // v0.2: storage backend selection. "sidecar" = one JSON file per note
  // in the configured folder (default; recommended for sync robustness).
  // "dataJson" = all records in the plugin's own data.json.
  storageBackend: "sidecar" | "dataJson";
  // Stable identifier for this device, embedded in every event so
  // multi-device merges can resolve LWW deterministically. Generated
  // on first run; user-regenerable from settings for vault clones.
  deviceId: string;
  // Optional human-readable label (e.g. "MacBook Pro"). Not currently
  // surfaced; reserved for future per-device color/legend UI.
  deviceLabel: string;
}

const DEFAULT_SETTINGS: AuthorshipSettings = {
  showAIStyling: true,
  showPasteMenuItem: true,
  showMarkSelectionMenuItem: true,
  showRemoveMenuItem: true,
  gradientStops: [
    "#78A8FF",
    "#8F98FF",
    "#A786F3",
    "#CB7FE2",
    "#F08BC8",
  ],
  orientation: "vertical",
  waviness: 1.0,
  showInReadingMode: false,
  debug: false,
  sidecarFolderPath: "z-author-sync",
  previousSidecarFolderPath: null,
  storageBackend: "dataJson",
  deviceId: "",
  deviceLabel: "",
};

// ---- state effects & field ----

const addAIRange = StateEffect.define<AIRange>();
const replaceAIRanges = StateEffect.define<AIRange[]>();
const clearAIRange = StateEffect.define<AIRange>();
const refreshDecorationsEffect = StateEffect.define<null>();

const aiRangeField = StateField.define<AIRange[]>({
  create: () => [],
  update(ranges, tr) {
    // Step 1: map each existing range through the change set.
    // side=1 at `from` and side=-1 at `to` keeps insertions at the
    // boundaries OUTSIDE the range (new chars typed adjacent stay normal).
    // Author is preserved across mapping.
    let next: AIRange[] = [];
    for (const range of ranges) {
      const from = tr.changes.mapPos(range.from, 1);
      const to = tr.changes.mapPos(range.to, -1);
      if (to > from) next.push({ from, to, author: authorOf(range) });
    }

    // Step 2: subtract every inserted/replaced region from all ranges.
    // This is what keeps "typing inside an AI range produces normal chars"
    // working. No targetAuthor → strips coverage from all authors at the
    // typed location (typed chars belong to nobody until v0.3 capture mode).
    tr.changes.iterChanges((_fromA, _toA, fromB, toB) => {
      if (toB <= fromB) return; // pure deletion, handled by mapPos above
      next = subtractInterval(next, fromB, toB);
    });

    // Step 3: apply explicit effects (Paste as AI, hydration, Remove AI, etc.)
    for (const effect of tr.effects) {
      if (effect.is(addAIRange)) {
        next = mergeRange(next, effect.value);
      } else if (effect.is(replaceAIRanges)) {
        next = normalizeRanges(effect.value);
      } else if (effect.is(clearAIRange)) {
        // Per-author clear when author is specified, universal otherwise.
        // v0.2 always specifies "ai" (default); v0.3 may use other authors.
        next = subtractInterval(next, effect.value.from, effect.value.to, authorOf(effect.value));
      }
    }

    // Normalize to merge any adjacent ranges produced by the combination of
    // mapping + subtraction + effects.
    return normalizeRanges(next);
  },
});

// ---- range helpers ----
//
// mergeRange / subtractInterval / normalizeRanges / sameRanges live in
// src/schema.ts and are imported above. They are author-aware: ranges
// with different authors never merge into one another. v0.2 always
// uses "ai" so behavior is identical to v0.1.

function selectionOverlapsAI(view: EditorView, selFrom: number, selTo: number): boolean {
  if (selTo <= selFrom) return false;
  const ranges = view.state.field(aiRangeField, false) ?? [];
  for (const r of ranges) {
    if (r.to > selFrom && r.from < selTo) return true;
  }
  return false;
}

function selectionFullyAI(view: EditorView, selFrom: number, selTo: number): boolean {
  if (selTo <= selFrom) return false;
  const ranges = view.state.field(aiRangeField, false) ?? [];
  // Walk through ranges sorted by start; see if they collectively cover [selFrom, selTo].
  let cursor = selFrom;
  for (const r of ranges) {
    if (r.to <= cursor) continue;
    if (r.from > cursor) return false; // gap — not fully covered
    cursor = r.to;
    if (cursor >= selTo) return true;
  }
  return cursor >= selTo;
}

// ---- sidecar I/O ----

// Sidecars live in a visible `z-author-sync/` folder at the vault root.
// Rides the same sync path as markdown when "Sync all other file types"
// is enabled in Obsidian Sync. The `z-` prefix sorts the folder to the
// bottom of the file explorer so it stays out of the way.
const PLUGIN_ID = "aistyled-authorship";
const SIDECAR_FOLDER = "z-author-sync";
const LEGACY_DOT_FOLDER = ".authorship";
const LEGACY_VAULT_ROOT_FOLDER = "authorship";
// SIDECAR_VERSION removed in v0.2 — schema versions are owned by src/schema.ts.

const SIDECAR_README_FILENAME = "README.md";
const SIDECAR_README_BODY = `# AI Styled Authorship — sync data

This folder exists to sync AI authorship styling across your devices.
Each note that has AI-pasted text gets a small JSON sidecar here,
tracking which character ranges the plugin should color as AI-authored.

## Hide this folder in Obsidian

You can hide this folder from the file explorer without affecting sync.

**Option A — one click (recommended):** Open the plugin's settings
(Settings → Community plugins → AI Styled Authorship → Options), expand
the **Installation instructions** section if it isn't already, and
click **Hide z-author-sync/ folder**.

**Option B — manual via Settings:**

1. Open **Settings → Files and links**.
2. Under **Excluded files**, click **Add excluded folder**.
3. Type: \`z-author-sync/\`
4. Close settings.

**Option C — right-click (only if you have it):** Some file-management
plugins (such as *File Hider*) add a right-click *Hide* item to the
file explorer. If you have one of those plugins installed, right-click
this folder and pick the hide/exclude option. Vanilla Obsidian's
right-click menu does not include this — use A or B if you don't have
an extension that provides it.

Once hidden, the folder stops appearing in searches, graph views, and
the file explorer. Sync and the plugin still read and write here
normally.

## Commands

Three commands are available via the command palette (Cmd/Ctrl+P) or a
hotkey you assign in Settings → Hotkeys:

- **Paste as AI** — paste clipboard contents marked as AI-authored so
  the gradient is applied immediately.
- **Mark selection as AI** — tag currently selected text as
  AI-authored.
- **Remove AI styling** — clear AI styling from the selection (or the
  current note if nothing is selected).

## Why the \`z-\` prefix?

The folder is named \`z-author-sync\` so it sorts to the bottom of the
file explorer by default, keeping it out of the way. Older versions of
the plugin used \`authorship/\` — sidecars are migrated automatically
on load.

## Safe to delete?

Deleting this folder erases all AI-authorship gradients in your vault.
The plugin will rebuild sidecars as you paste new AI text, but existing
styling on older notes will be lost. If you just want the folder out of
sight, use one of the hide options above instead.

---

*Created and maintained by the AI Styled Authorship plugin.*
`;

// Sidecar I/O is delegated to the StorageBackend (src/storage.ts).
// The path encoder lives there too and is imported above so existing
// references to encodeSidecarPath continue to work unchanged.

// ---- gradient rendering ----

// Default palette: cascade blue -> pink (the "Cascade" preset).
const DEFAULT_GRADIENT_HEX: string[] = [
  "#78A8FF", // core blue
  "#8F98FF", // blue-violet
  "#A786F3", // lavender-violet
  "#CB7FE2", // magenta-violet
  "#F08BC8", // warm pink edge
];

// Named presets. "Cascade" must match DEFAULT_GRADIENT_HEX.
const GRADIENT_PRESETS: { name: string; stops: string[] }[] = [
  { name: "Cascade",    stops: ["#78A8FF", "#8F98FF", "#A786F3", "#CB7FE2", "#F08BC8"] },
  { name: "Sunset",     stops: ["#FFB56B", "#FF8E85", "#E56B9A", "#B566C8", "#7E70D8"] },
  { name: "Ocean",      stops: ["#0B7FB3", "#0AAAB8", "#2ED3B5", "#7DE8AA", "#C4F0A3"] },
  { name: "Forest",     stops: ["#2A7F52", "#5EA86E", "#A3C97B", "#D9D17B", "#E89B4B"] },
  { name: "Monochrome", stops: ["#6B6B6B", "#8A8A8A", "#A8A8A8", "#C4C4C4", "#E0E0E0"] },
  { name: "Deep Blue",  stops: ["#1E3A8A", "#3B5BB5", "#5B7DD6", "#8CA4E5", "#C8D4F0"] },
];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  return {
    r: parseInt(full.slice(0, 2), 16) || 0,
    g: parseInt(full.slice(2, 4), 16) || 0,
    b: parseInt(full.slice(4, 6), 16) || 0,
  };
}

function stopsFromHex(hex: string[]): Stop[] {
  if (hex.length < 2) hex = DEFAULT_GRADIENT_HEX;
  return hex.map((h, i) => ({
    pos: i / (hex.length - 1),
    rgb: hexToRgb(h),
  }));
}

function colorAt(stops: Stop[], t: number): string {
  const tc = clamp(t, 0, 1);
  for (let i = 0; i < stops.length - 1; i++) {
    const start = stops[i];
    const end = stops[i + 1];
    if (tc <= end.pos) {
      const local = (tc - start.pos) / (end.pos - start.pos);
      const r = Math.round(start.rgb.r + (end.rgb.r - start.rgb.r) * local);
      const g = Math.round(start.rgb.g + (end.rgb.g - start.rgb.g) * local);
      const b = Math.round(start.rgb.b + (end.rgb.b - start.rgb.b) * local);
      return `rgb(${r},${g},${b})`;
    }
  }
  const last = stops[stops.length - 1].rgb;
  return `rgb(${last.r},${last.g},${last.b})`;
}

function buildLineDecoration(color: string): Decoration {
  return Decoration.mark({
    class: "leftcoast-ai-chunk",
    attributes: {
      style: `color: ${color} !important; -webkit-text-fill-color: ${color} !important;`,
    },
  });
}

function buildGradientLineDeco(gradientCss: string): Decoration {
  // One decoration per visual line. Parent span gets a CSS gradient clipped
  // to the text; transparent fill reveals the clipped gradient. Children
  // (bold, italic, links, code) inherit transparent via styles.css.
  return Decoration.mark({
    class: "leftcoast-ai-chunk",
    attributes: {
      style:
        `background: ${gradientCss} !important; ` +
        "background-clip: text !important; " +
        "-webkit-background-clip: text !important; " +
        "color: transparent !important; " +
        "-webkit-text-fill-color: transparent !important;",
    },
  });
}

function buildLineGradient(
  stops: Stop[],
  orientation: GradientOrientation,
  amp: number,
  field: GradientField,
  block: { from: number; to: number; top: number; bottom: number; height: number },
  markLeftPx: number,
  markRightPx: number
): string {
  const N = 20; // sample density
  const parts: string[] = [];
  const span = Math.max(markRightPx - markLeftPx, 1);

  if (orientation === "vertical") {
    // River: for each sample at xFrac of the mark element, convert to the
    // corresponding absolute pixel-x in the field, then compute distance
    // to the drifting ribbon center.
    const phase = ((block.top - field.rangeTop) / field.wavePeriod) * Math.PI * 2;
    const centerPx = field.baseCenterX + Math.sin(phase) * amp;
    const hRadius = Math.max(field.horizontalRadius, 1);

    for (let i = 0; i <= N; i++) {
      const xFrac = i / N;
      const pixelX = markLeftPx + xFrac * span;
      const d = clamp(Math.abs(pixelX - centerPx) / hRadius, 0, 1);
      parts.push(`${colorAt(stops, d)} ${(xFrac * 100).toFixed(2)}%`);
    }
  } else {
    // Sunset: each sample's absolute pixel-x yields a centerY that drifts
    // with x, then we compare the line's rowY to that.
    const rowY = block.top + block.height / 2;
    const vRadius = Math.max(field.verticalRadius, 1);
    for (let i = 0; i <= N; i++) {
      const xFrac = i / N;
      const pixelX = markLeftPx + xFrac * span;
      const phase = ((pixelX - field.fieldLeft) / field.wavePeriod) * Math.PI * 2;
      const centerY = field.baseCenterY + Math.sin(phase) * amp;
      const d = clamp(Math.abs(rowY - centerY) / vRadius, 0, 1);
      parts.push(`${colorAt(stops, d)} ${(xFrac * 100).toFixed(2)}%`);
    }
  }

  return `linear-gradient(90deg, ${parts.join(", ")})`;
}

function buildGradientField(view: EditorView, rangeFrom: number, rangeTo: number): GradientField {
  // Measure the actual rendered width of a `.cm-line` element belonging to
  // this range. Obsidian's readable-line-length means `.cm-content` is
  // typically wider than the lines within it — using contentDOM here caused
  // the ribbon center to sit past the right edge of typical-length lines.
  //
  // Falls back to contentDOM bounds if we can't find a line element.
  const contentRect = view.contentDOM.getBoundingClientRect();
  const charWidth = Math.max(view.defaultCharacterWidth, 4);

  let lineLeftPx = contentRect.left;
  let lineRightPx = contentRect.right;

  try {
    const domPos = view.domAtPos(rangeFrom);
    let el: Node | null = domPos.node;
    // Walk up to find the .cm-line ancestor.
    while (el && !(el instanceof HTMLElement && el.classList?.contains("cm-line"))) {
      el = el.parentNode;
    }
    if (el instanceof HTMLElement) {
      const lineRect = el.getBoundingClientRect();
      if (lineRect.width > charWidth * 4) {
        lineLeftPx = lineRect.left;
        lineRightPx = lineRect.right;
      }
    }
  } catch {
    // Fall back to contentRect; leave lineLeftPx/lineRightPx as-is.
  }

  const fieldLeft = lineLeftPx;
  const fieldWidth = Math.max(lineRightPx - lineLeftPx, charWidth * 8);
  const topBlock = view.lineBlockAt(rangeFrom);
  const bottomBlock = view.lineBlockAt(rangeTo);
  const rangeTop = topBlock.top;
  const rangeBottom = bottomBlock.bottom;
  const fieldHeight = Math.max(rangeBottom - rangeTop, topBlock.height);

  return {
    baseCenterX: fieldLeft + fieldWidth / 2,
    baseCenterY: rangeTop + fieldHeight / 2,
    rangeTop,
    rangeBottom,
    horizontalRadius: fieldWidth / 2,
    verticalRadius: Math.max(fieldHeight / 2, topBlock.height),
    fieldLeft,
    fieldSpan: fieldWidth,
    contentLeft: fieldLeft,
    charWidth,
    // 15% of field width at waviness=1 (default). Multiplied by `waviness`
    // at the build site, so 0% → flat, 100% → 15%, 200% → 30%.
    waveAmplitude: fieldWidth * 0.15,
    // ~15 lines per full wave cycle. Gentle meander, not noisy.
    wavePeriod: Math.max(topBlock.height, 24) * 15,
  };
}

function intersectRange(a: AIRange, b: AIRange): AIRange | null {
  const from = Math.max(a.from, b.from);
  const to = Math.min(a.to, b.to);
  return to > from ? { from, to } : null;
}

function buildVisibleSlices(view: EditorView, range: AIRange): AIRange[] {
  const slices: AIRange[] = [];
  for (const visible of view.visibleRanges) {
    const slice = intersectRange(range, visible);
    if (slice) slices.push(slice);
  }
  return slices;
}

function rowCenterX(field: GradientField, rowTop: number): number {
  const phase = ((rowTop - field.rangeTop) / field.wavePeriod) * Math.PI * 2;
  return field.baseCenterX + Math.sin(phase) * field.waveAmplitude;
}

// ---- mobile-safe clipboard read ----
// Returns null if clipboard read fails (permission denied, API unavailable).
// Returns empty string if clipboard read succeeded but is empty.
async function readClipboardText(): Promise<string | null> {
  try {
    if (!navigator.clipboard || !navigator.clipboard.readText) return null;
    const text = await navigator.clipboard.readText();
    return text ?? "";
  } catch {
    return null;
  }
}

// ---- clipboard handlers: copy/cut/paste preserve authorship within the vault ----

const CLIPBOARD_MIME = "application/x-aistyled-authorship+json";
const CLIPBOARD_VERSION = 1;

interface ClipboardAuthorship {
  version: number;
  text: string;
  ranges: { from: number; to: number }[];
}

function handleCopyOrCut(event: ClipboardEvent, view: EditorView, isCut: boolean): boolean {
  const sel = view.state.selection.main;
  if (sel.empty) return false;
  if (!event.clipboardData) return false;

  const ranges = view.state.field(aiRangeField, false) ?? [];
  const aiSegments: { from: number; to: number }[] = [];
  for (const r of ranges) {
    const a = Math.max(r.from, sel.from);
    const b = Math.min(r.to, sel.to);
    if (b > a) {
      aiSegments.push({ from: a - sel.from, to: b - sel.from });
    }
  }
  if (aiSegments.length === 0) return false; // nothing to tag, let default happen

  const text = view.state.sliceDoc(sel.from, sel.to);
  const payload: ClipboardAuthorship = {
    version: CLIPBOARD_VERSION,
    text,
    ranges: aiSegments,
  };

  event.clipboardData.setData("text/plain", text);
  event.clipboardData.setData(CLIPBOARD_MIME, JSON.stringify(payload));
  event.preventDefault();

  if (isCut) {
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: "" },
      selection: { anchor: sel.from },
    });
  }
  return true;
}

function handlePaste(event: ClipboardEvent, view: EditorView): boolean {
  if (!event.clipboardData) return false;
  const meta = event.clipboardData.getData(CLIPBOARD_MIME);
  if (!meta) return false;

  let data: Partial<ClipboardAuthorship> | null = null;
  try {
    data = JSON.parse(meta);
  } catch {
    return false;
  }
  if (!data || !Array.isArray(data.ranges)) return false;

  const plain = event.clipboardData.getData("text/plain");
  const text = plain || (typeof data.text === "string" ? data.text : "");
  if (!text) return false;

  const sel = view.state.selection.main;
  const insertStart = sel.from;
  const insertEnd = insertStart + text.length;

  const effects = data.ranges
    .filter(r => r && typeof r.from === "number" && typeof r.to === "number" && r.to > r.from)
    .map(r => addAIRange.of({
      from: insertStart + r.from,
      to: insertStart + r.to,
    }));

  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: text },
    effects,
    selection: { anchor: insertEnd },
  });

  event.preventDefault();
  return true;
}

const clipboardHandlers = EditorView.domEventHandlers({
  copy: (event, view) => handleCopyOrCut(event, view, false),
  cut: (event, view) => handleCopyOrCut(event, view, true),
  paste: (event, view) => handlePaste(event, view),
});

// ---- highlight view plugin ----

function createHighlightPlugin(
  onRangesMaybeChanged: (view: EditorView) => void,
  getConfig: () => GradientConfig
) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private rafPending = false;
      // Set when we dispatch our own refresh. The resulting update should
      // skip rescheduling (decorations are already up-to-date).
      private justRefreshed = false;

      constructor(view: EditorView) {
        this.scheduleRAF(view);
      }

      update(update: ViewUpdate) {
        const rangesChanged =
          update.state.field(aiRangeField, false) !==
          update.startState.field(aiRangeField, false);

        const refreshRequested = update.transactions.some(tr =>
          tr.effects.some(e => e.is(refreshDecorationsEffect))
        );

        // Skip if this update is purely our own post-build dispatch.
        if (refreshRequested && this.justRefreshed) {
          this.justRefreshed = false;
          return;
        }

        if (
          update.docChanged ||
          update.viewportChanged ||
          update.geometryChanged ||
          rangesChanged ||
          refreshRequested
        ) {
          this.scheduleRAF(update.view);
        }

        if (rangesChanged || update.docChanged) {
          onRangesMaybeChanged(update.view);
        }
      }

      // Use requestAnimationFrame instead of CM6's requestMeasure.
      // rAF fires after layout settles so coordsAtPos works safely.
      // Dispatching from rAF is outside the update cycle so no errors.
      scheduleRAF(view: EditorView) {
        if (this.rafPending) {
          if (getConfig().debug) console.log("AiStyled: scheduleRAF skipped (pending)");
          return;
        }
        this.rafPending = true;
        requestAnimationFrame(() => {
          this.rafPending = false;
          if (!view.dom.isConnected) return;
          if (getConfig().debug) console.log("AiStyled: rAF build firing");
          const decos = this.buildWithMeasurements(view);
          if (decos) {
            this.decorations = decos;
            this.justRefreshed = true;
            view.dispatch({ effects: refreshDecorationsEffect.of(null) });
          }
        });
      }

      // Per-character coloring with REAL pixel positions from coordsAtPos.
      // This matches the Settings preview's approach exactly. Handles wrapped
      // lines correctly because each character knows its own (x, y), not
      // derived from a per-document-line approximation.
      buildWithMeasurements(view: EditorView): DecorationSet | null {
        const builder = new RangeSetBuilder<Decoration>();
        const ranges = view.state.field(aiRangeField, false) ?? [];
        if (ranges.length === 0) return Decoration.none;
        const docLength = view.state.doc.length;
        const { stops, orientation, waviness, debug } = getConfig();
        if (debug) {
          console.group("AiStyled: buildWithMeasurements");
        }

        for (let ri = 0; ri < ranges.length; ri++) {
          const range = ranges[ri];
          const from = Math.max(0, range.from);
          const to = Math.min(docLength, range.to);
          if (to <= from) continue;

          const field = buildGradientField(view, from, to);
          const amp = field.waveAmplitude * waviness;

          if (debug) {
            console.log(`range ${ri}: [${from}..${to}]`, {
              baseCenterX: field.baseCenterX,
              baseCenterY: field.baseCenterY,
              horizontalRadius: field.horizontalRadius,
              verticalRadius: field.verticalRadius,
              rangeTop: field.rangeTop,
              rangeBottom: field.rangeBottom,
              amp,
            });
          }

          // Chunk into groups of CHUNK_SIZE characters. Each chunk gets the
          // color of its first character's measured position. This keeps the
          // DOM manageable (~200 spans for a 1000-char range instead of 1000)
          // while preserving per-position gradient accuracy.
          const CHUNK_SIZE = 5;
          for (const slice of buildVisibleSlices(view, { from, to })) {
            const debugSamples: Array<{ pos: number; x: number; y: number; d: number }> = [];
            for (let pos = slice.from; pos < slice.to; pos += CHUNK_SIZE) {
              const chunkEnd = Math.min(pos + CHUNK_SIZE, slice.to);
              let coords: { left: number; right: number; top: number; bottom: number } | null = null;
              try {
                coords = view.coordsAtPos(pos, 1);
              } catch {
                continue;
              }
              if (!coords) continue;

              const x = (coords.left + coords.right) / 2;
              const y = (coords.top + coords.bottom) / 2;

              let d: number;
              if (orientation === "vertical") {
                const phase = ((y - field.rangeTop) / field.wavePeriod) * Math.PI * 2;
                const centerX = field.baseCenterX + Math.sin(phase) * amp;
                d = clamp(Math.abs(x - centerX) / field.horizontalRadius, 0, 1);
              } else {
                const phase = ((x - field.fieldLeft) / field.wavePeriod) * Math.PI * 2;
                const centerY = field.baseCenterY + Math.sin(phase) * amp;
                d = clamp(Math.abs(y - centerY) / field.verticalRadius, 0, 1);
              }

              const color = colorAt(stops, d);
              builder.add(pos, chunkEnd, buildLineDecoration(color));

              if (debug && debugSamples.length < 5) {
                debugSamples.push({ pos, x, y, d });
              }
            }
            if (debug) {
              console.log(`slice [${slice.from}..${slice.to}] first 5 chunks:`, debugSamples);
            }
          }
        }

        if (debug) console.groupEnd();
        return builder.finish();
      }
    },
    { decorations: v => v.decorations }
  );
}

// ---- plugin ----

const WRITE_DEBOUNCE_MS = 300;

export default class LeftcoastAuthorshipPlugin extends Plugin {
  private writeTimers: Map<string, number> = new Map();
  private lastPersisted: Map<string, AIRange[]> = new Map();
  // Files for which we've finished (or confirmed no need for) hydration.
  // Writes are blocked for a file until it's in this set — prevents the
  // "plugin wipes sidecar before it could read it" bug on startup.
  private hydrated: Set<string> = new Set();
  settings: AuthorshipSettings = { ...DEFAULT_SETTINGS };

  // v0.2 storage layer
  backend!: StorageBackend;
  conflictScanner!: ConflictScanner;
  // Per-session "approaching cap" warning latch — one Notice per session.
  private warnedNearCap = false;

  async onload() {
    await this.loadSettings();
    await this.ensureDeviceId();
    this.backend = this.buildBackend();
    this.conflictScanner = this.buildConflictScanner();

    this.registerEditorExtension([
      aiRangeField,
      clipboardHandlers,
      createHighlightPlugin(
        view => this.onRangesMaybeChanged(view),
        () => ({
          stops: stopsFromHex(this.settings.gradientStops),
          orientation: this.settings.orientation,
          waviness: this.settings.waviness,
          debug: this.settings.debug,
        })
      ),
    ]);

    this.addSettingTab(new AuthorshipSettingTab(this.app, this));
    this.applyStylingToggle();

    // One-time migration: move sidecars from .authorship/ to authorship/.
    // iOS iCloud Drive doesn't sync dotfolders reliably.
    void this.migrateSidecarFolder();

    this.addCommand({
      id: "paste-as-ai",
      name: "Paste with AI Style",
      editorCallback: async (editor: Editor) => {
        await this.runPasteWithAI(editor);
      },
    });

    this.addCommand({
      id: "mark-selection-as-ai",
      name: "Mark Selection as AI Style",
      editorCallback: (editor: Editor) => {
        this.runMarkSelectionAsAI(editor);
      },
    });

    this.addCommand({
      id: "remove-ai-styling",
      name: "Remove AI Styling",
      editorCallback: (editor: Editor) => {
        this.runRemoveAI(editor);
      },
    });

    this.addCommand({
      id: "dump-debug-info",
      name: "Dump debug info for current note",
      editorCallback: (editor: Editor) => {
        this.runDumpDebug(editor);
      },
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, _view: MarkdownView) => {
        if (this.settings.showPasteMenuItem) {
          menu.addItem(item => {
            item
              .setTitle("Paste with AI Style")
              .setIcon("clipboard-paste")
              .onClick(async () => {
                await this.runPasteWithAI(editor);
              });
          });
        }

        // @ts-ignore Obsidian exposes the CM6 EditorView via editor.cm
        const cm: EditorView | undefined = (editor as any).cm;
        if (cm) {
          const sel = cm.state.selection.main;

          // Show "Mark Selection as AI Style" when selection is non-empty and
          // not already fully covered by an AI range.
          if (this.settings.showMarkSelectionMenuItem && !sel.empty && !selectionFullyAI(cm, sel.from, sel.to)) {
            menu.addItem(item => {
              item
                .setTitle("Mark Selection as AI Style")
                .setIcon("highlighter")
                .onClick(() => {
                  this.runMarkSelectionAsAI(editor);
                });
            });
          }

          // Show "Remove AI Styling" when selection overlaps an AI range.
          if (this.settings.showRemoveMenuItem && !sel.empty && selectionOverlapsAI(cm, sel.from, sel.to)) {
            menu.addItem(item => {
              item
                .setTitle("Remove AI Styling")
                .setIcon("eraser")
                .onClick(() => {
                  this.runRemoveAI(editor);
                });
            });
          }
        }
      })
    );

    // Hydrate on file open
    this.registerEvent(
      this.app.workspace.on("file-open", file => {
        if (file) void this.hydrateFile(file);
      })
    );

    // Initial hydration for whatever file is already open when the plugin loads
    this.app.workspace.onLayoutReady(() => {
      const active = this.app.workspace.getActiveFile();
      if (active) void this.hydrateFile(active);
    });

    // Rename hook — relocate the stored record alongside the note
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) {
          void this.backend.rename(oldPath, file.path);
          const cached = this.lastPersisted.get(oldPath);
          if (cached) {
            this.lastPersisted.set(file.path, cached);
            this.lastPersisted.delete(oldPath);
          }
          if (this.hydrated.has(oldPath)) {
            this.hydrated.delete(oldPath);
            this.hydrated.add(file.path);
          }
        }
      })
    );

    // Sidecar arrived via sync — merge its ranges into the current
    // editor state (union of folded ranges). Also opportunistically
    // checks if the touched file is a sync-conflict copy and merges
    // it into the canonical sidecar. Skipped entirely under the
    // dataJson backend (sidecar folder is not in use).
    const onSidecarTouched = (filePath: string) => {
      const folder = this.backend.sidecarFolder();
      if (!folder) return;
      if (!filePath.startsWith(folder + "/")) return;
      const filename = filePath.slice(folder.length + 1);
      if (filename === SIDECAR_README_FILENAME) return;
      if (!filename.endsWith(".json")) return;

      // First, try to resolve as a conflict copy.
      void this.conflictScanner.scanPath(filePath).then(merged => {
        if (merged) return;
        // Not a conflict — treat as a canonical sidecar update.
        const encoded = filename.slice(0, -5);
        const notePath = encoded.replace(/__/g, "/");
        const noteFile = this.app.vault.getAbstractFileByPath(notePath);
        if (!(noteFile instanceof TFile)) return;
        void this.mergeSidecarIntoView(noteFile);
      });
    };
    this.registerEvent(
      this.app.vault.on("create", file => {
        if (file instanceof TFile) onSidecarTouched(file.path);
      })
    );
    this.registerEvent(
      this.app.vault.on("modify", file => {
        if (file instanceof TFile) onSidecarTouched(file.path);
      })
    );

    // Delete hook — drop the stored record
    this.registerEvent(
      this.app.vault.on("delete", file => {
        if (file instanceof TFile) {
          void this.backend.delete(file.path);
          this.lastPersisted.delete(file.path);
          this.hydrated.delete(file.path);
          const pending = this.writeTimers.get(file.path);
          if (pending !== undefined) {
            window.clearTimeout(pending);
            this.writeTimers.delete(file.path);
          }
        }
      })
    );

    // App-focus rescan — catches conflict copies that arrived while
    // the window was in the background.
    this.registerDomEvent(window, "focus", () => {
      void this.conflictScanner.scanAll();
    });

    // Initial conflict sweep on startup. Runs in the background; if it
    // finds anything it triggers per-note merges via onMerged.
    this.app.workspace.onLayoutReady(() => {
      void this.conflictScanner.scanAll();
    });

    // Reading-mode post-processor: DISABLED for now. The gradient treatment
    // in Obsidian's reading-mode renderer requires deeper understanding of
    // how post-processors interact with the DOM. Multiple approaches were
    // attempted (inline styles, CSS classes, background-clip: text) and all
    // caused layout artifacts. Deferred until we can properly research the
    // rendering pipeline. The setting toggle remains in the UI but does
    // nothing when enabled.
    //
    // TODO: revisit reading-mode support in a future release.

    console.log(
      `AiStyled-Authorship: loaded (${Platform.isMobile ? "mobile" : "desktop"})`
    );
  }

  private async runPasteWithAI(editor: Editor) {
    const text = await readClipboardText();
    if (text == null) {
      new Notice(
        Platform.isMobile
          ? "Could not read clipboard. Grant clipboard access and try again."
          : "Could not read clipboard"
      );
      return;
    }
    if (text.length === 0) {
      new Notice("Clipboard is empty");
      return;
    }
    this.pasteAsAI(editor, text);
  }

  private runMarkSelectionAsAI(editor: Editor) {
    // @ts-ignore Obsidian exposes the CM6 EditorView via editor.cm
    const cm: EditorView = (editor as any).cm;
    if (!cm) {
      new Notice("Could not access editor");
      return;
    }
    const sel = cm.state.selection.main;
    if (sel.empty) {
      new Notice("Select text to mark as AI-styled");
      return;
    }
    cm.dispatch({
      effects: addAIRange.of({ from: sel.from, to: sel.to }),
    });
  }

  private runDumpDebug(editor: Editor) {
    // @ts-ignore Obsidian exposes the CM6 EditorView via editor.cm
    const cm: EditorView = (editor as any).cm;
    if (!cm) {
      new Notice("Could not access editor");
      return;
    }
    const ranges = cm.state.field(aiRangeField, false) ?? [];
    const doc = cm.state.doc;

    console.group("=== Leftcoast Authorship: Debug Dump ===");
    console.log("settings:", JSON.parse(JSON.stringify(this.settings)));
    console.log("ranges:", ranges);
    console.log("doc length:", doc.length);

    const contentRect = cm.contentDOM.getBoundingClientRect();
    const scrollRect = cm.scrollDOM.getBoundingClientRect();
    console.log("contentDOM rect:", {
      left: contentRect.left,
      right: contentRect.right,
      width: contentRect.width,
    });
    console.log("scrollDOM rect:", {
      left: scrollRect.left,
      right: scrollRect.right,
      width: scrollRect.width,
    });
    console.log("defaultCharacterWidth:", cm.defaultCharacterWidth);

    for (let ri = 0; ri < ranges.length; ri++) {
      const r = ranges[ri];
      console.group(`range ${ri}: [${r.from}..${r.to}]`);

      // Measure the first line of this range.
      try {
        const domPos = cm.domAtPos(r.from);
        let el: Node | null = domPos.node;
        while (el && !(el instanceof HTMLElement && el.classList?.contains("cm-line"))) {
          el = el.parentNode;
        }
        if (el instanceof HTMLElement) {
          const lineRect = el.getBoundingClientRect();
          console.log("first line .cm-line rect:", {
            left: lineRect.left,
            right: lineRect.right,
            width: lineRect.width,
          });
        } else {
          console.log("first line .cm-line rect: NOT FOUND");
        }
      } catch (err) {
        console.log("domAtPos error:", err);
      }

      const field = buildGradientField(cm, r.from, r.to);
      console.log("buildGradientField result:", {
        baseCenterX: field.baseCenterX,
        baseCenterY: field.baseCenterY,
        fieldLeft: field.fieldLeft,
        fieldSpan: field.fieldSpan,
        horizontalRadius: field.horizontalRadius,
        verticalRadius: field.verticalRadius,
        rangeTop: field.rangeTop,
        rangeBottom: field.rangeBottom,
        waveAmplitude: field.waveAmplitude,
        wavePeriod: field.wavePeriod,
      });

      // Walk the first 3 visual lines and show measured bounds.
      let cursor = r.from;
      let lineIdx = 0;
      while (cursor < r.to && cursor <= doc.length && lineIdx < 3) {
        const block = cm.lineBlockAt(cursor);
        const segFrom = Math.max(block.from, r.from);
        const segTo = Math.min(block.to, r.to);
        if (segTo > segFrom) {
          try {
            const sc = cm.coordsAtPos(segFrom, 1);
            const ec = cm.coordsAtPos(segTo, -1);
            console.log(`line ${lineIdx} [${segFrom}..${segTo}]:`, {
              blockTop: block.top,
              blockHeight: block.height,
              markLeftPx: sc?.left,
              markRightPx: ec?.right,
              spanWidth: sc && ec ? ec.right - sc.left : null,
            });
          } catch (err) {
            console.log(`line ${lineIdx}: coordsAtPos error`, err);
          }
        }
        if (block.to >= r.to) break;
        cursor = block.to + 1;
        lineIdx++;
      }

      console.groupEnd();
    }

    console.groupEnd();
    new Notice("Debug info dumped to console (Cmd+Option+I to view)");
  }

  private runRemoveAI(editor: Editor) {
    // @ts-ignore Obsidian exposes the CM6 EditorView via editor.cm
    const cm: EditorView = (editor as any).cm;
    if (!cm) {
      new Notice("Could not access editor");
      return;
    }
    const sel = cm.state.selection.main;
    if (sel.empty) {
      new Notice("Select AI-styled text to remove its styling");
      return;
    }
    if (!selectionOverlapsAI(cm, sel.from, sel.to)) {
      new Notice("Selection has no AI styling");
      return;
    }
    cm.dispatch({
      effects: clearAIRange.of({ from: sel.from, to: sel.to }),
    });
  }

  private pasteAsAI(editor: Editor, text: string) {
    // @ts-ignore Obsidian exposes the CM6 EditorView via editor.cm
    const cm: EditorView = (editor as any).cm;
    if (!cm) {
      new Notice("Could not access editor");
      return;
    }

    const from = cm.state.selection.main.from;
    const to = cm.state.selection.main.to;
    const insertEnd = from + text.length;

    cm.dispatch({
      changes: { from, to, insert: text },
      effects: addAIRange.of({ from, to: insertEnd }),
      selection: { anchor: insertEnd },
    });
  }

  // Re-hydrates ALL open markdown editors from the backend. Used after
  // a backend switch or after a destructive cache delete so the visible
  // gradient state matches what's now in storage.
  async rehydrateAllOpen(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file) {
        await this.hydrateFile(view.file);
      }
    }
  }

  private async mergeSidecarIntoView(file: TFile) {
    const { ranges } = await this.backend.load(file.path);
    if (ranges.length === 0) return;

    const view = this.findEditorView(file);
    if (!view) {
      // View isn't open. Still cache so lastPersisted reflects disk state
      // and next hydrateFile picks it up when the view opens.
      this.lastPersisted.set(file.path, ranges);
      return;
    }

    const current = view.state.field(aiRangeField, false) ?? [];
    const merged = normalizeRanges([...current, ...ranges]);

    // Skip dispatch if merged is identical to current (nothing new arrived).
    if (sameRanges(current, merged)) {
      this.lastPersisted.set(file.path, merged);
      this.hydrated.add(file.path);
      return;
    }

    queueMicrotask(() => {
      const liveView = this.findEditorView(file);
      if (!liveView) return;
      liveView.dispatch({ effects: replaceAIRanges.of(merged) });
      this.lastPersisted.set(file.path, merged);
      this.hydrated.add(file.path);
    });
  }

  private async hydrateFile(file: TFile, attempt = 0) {
    console.warn("[AiStyled HYDRATE] hydrateFile:", file.path, "attempt:", attempt);
    // Don't block on `hydrated` — that set gates WRITES only (in
    // onRangesMaybeChanged). We always attempt to load from the backend
    // when the editor's field is empty, even if we've hydrated before,
    // because CM6 creates a fresh empty state when the user switches
    // away and back.
    if (this.writeTimers.has(file.path)) {
      console.warn("[AiStyled HYDRATE] → write pending, skipping");
      return;
    }

    const view = this.findEditorView(file);
    if (!view) {
      // Editor may not yet be constructed at this moment (common on app
      // startup). Retry with backoff up to ~1s before giving up.
      if (attempt < 20) {
        window.setTimeout(() => void this.hydrateFile(file, attempt + 1), 50);
      }
      return;
    }

    const { ranges } = await this.backend.load(file.path);

    if (ranges.length === 0) {
      // No record. Mark hydrated — writes are allowed if the user adds
      // ranges later.
      this.hydrated.add(file.path);
      return;
    }

    const current = view.state.field(aiRangeField, false) ?? [];
    // Union: keep whatever the editor already has AND add the loaded
    // ranges. Handles multi-device case where the local state might
    // have been populated by earlier sync events or a previous session.
    const merged = normalizeRanges([...current, ...ranges]);

    if (sameRanges(current, merged)) {
      this.lastPersisted.set(file.path, merged);
      this.hydrated.add(file.path);
      return;
    }

    queueMicrotask(() => {
      const liveView = this.findEditorView(file);
      if (!liveView) return;
      liveView.dispatch({ effects: replaceAIRanges.of(merged) });
      this.lastPersisted.set(file.path, merged);
      this.hydrated.add(file.path);
    });
  }

  private findEditorView(file: TFile): EditorView | null {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file === file) {
        // @ts-ignore
        const cm: EditorView | undefined = (view.editor as any)?.cm;
        return cm ?? null;
      }
    }
    return null;
  }

  private pathForEditorView(view: EditorView): string | null {
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const mdView = leaf.view;
      if (!(mdView instanceof MarkdownView)) continue;
      // @ts-ignore
      const cm: EditorView | undefined = (mdView.editor as any)?.cm;
      if (cm === view) return mdView.file?.path ?? null;
    }
    return null;
  }

  private onRangesMaybeChanged(view: EditorView) {
    const path = this.pathForEditorView(view);
    console.warn("[AiStyled PERSIST] onRangesMaybeChanged: path =", path);
    if (!path) {
      console.warn("[AiStyled PERSIST] → pathForEditorView returned null, bailing");
      return;
    }
    const ranges = view.state.field(aiRangeField, false) ?? [];
    const normalized = normalizeRanges(ranges);
    console.warn("[AiStyled PERSIST] → ranges count:", normalized.length, "hydrated:", this.hydrated.has(path));

    // Empty ranges are still meaningful in v0.2: they represent "user
    // removed the last AI range" and should be persisted as remove
    // events. We rely on the diff against lastPersisted to figure out
    // whether anything actually changed.
    if (!this.hydrated.has(path)) {
      // Pre-hydration writes are unsafe — we'd diff against an empty
      // baseline and emit spurious add events for ranges that already
      // exist on disk. Mark hydrated only after a non-empty write or
      // an explicit hydrate.
      if (normalized.length === 0) {
        console.warn("[AiStyled PERSIST] → skipped: pre-hydration + empty");
        return;
      }
      console.warn("[AiStyled PERSIST] → marking hydrated (non-empty write)");
      this.hydrated.add(path);
    }

    const last = this.lastPersisted.get(path) ?? [];
    if (sameRanges(last, normalized)) {
      console.warn("[AiStyled PERSIST] → skipped: same as lastPersisted");
      return;
    }
    console.warn("[AiStyled PERSIST] → scheduling write for", path, "with", normalized.length, "ranges");
    this.scheduleWrite(path, last, normalized);
  }

  private scheduleWrite(notePath: string, previous: AIRange[], current: AIRange[]) {
    const existing = this.writeTimers.get(notePath);
    if (existing !== undefined) window.clearTimeout(existing);
    const timerId = window.setTimeout(() => {
      this.writeTimers.delete(notePath);
      console.warn("[AiStyled PERSIST] debounce fired for", notePath);
      void this.flushWrite(notePath, previous, current);
    }, WRITE_DEBOUNCE_MS);
    this.writeTimers.set(notePath, timerId);
  }

  private async flushWrite(notePath: string, previous: AIRange[], current: AIRange[]) {
    // Re-snapshot lastPersisted at flush time — it may have advanced
    // (e.g. via mergeSidecarIntoView from a sync event).
    const baseline = this.lastPersisted.get(notePath) ?? previous;
    const events = diffRangeSets(baseline, current, {
      ts: Date.now(),
      deviceId: this.settings.deviceId,
    });
    if (events.length === 0) {
      console.warn("[AiStyled PERSIST] → no events to write");
      this.lastPersisted.set(notePath, current);
      return;
    }
    console.warn("[AiStyled PERSIST] → appending", events.length, "events for", notePath);
    const result = await this.backend.appendEvents(notePath, events);
    if (result.exceededCap) {
      new Notice(
        "AI Authorship cache exceeded sync size limit (3.8 MB). " +
        "Latest changes were not saved. Delete unused entries via Settings."
      );
      return;
    }
    if (result.aggressivelyCompacted) {
      console.warn("[AiStyled PERSIST] → aggressive compaction triggered for", notePath);
    }
    if (
      result.bytes >= DATA_JSON_WARN_THRESHOLD &&
      result.bytes < DATA_JSON_SIZE_CAP_BYTES &&
      !this.warnedNearCap
    ) {
      this.warnedNearCap = true;
      new Notice(
        `AI Authorship cache approaching the sync size limit (~${Math.round(
          (result.bytes / DATA_JSON_SIZE_CAP_BYTES) * 100,
        )}%). Consider deleting unused entries.`,
      );
    }
    this.lastPersisted.set(notePath, current);
  }

  private get sidecarFolder(): string {
    const configured = this.settings?.sidecarFolderPath?.trim();
    return normalizePath(configured || SIDECAR_FOLDER);
  }

  // ---- backend construction & lifecycle ----

  private buildBackend(): StorageBackend {
    if (this.settings.storageBackend === "dataJson") {
      return new DataJsonStorage(this);
    }
    return new SidecarStorage(this.app.vault.adapter, () => this.sidecarFolder);
  }

  private buildConflictScanner(): ConflictScanner {
    return new ConflictScanner(
      this.app.vault.adapter,
      () => this.backend.sidecarFolder(),
      (notePath: string) => {
        const file = this.app.vault.getAbstractFileByPath(notePath);
        if (file instanceof TFile) void this.mergeSidecarIntoView(file);
      },
    );
  }

  // Public proxy used by settings UI's Regenerate button.
  async ensureDeviceIdPublic(): Promise<void> {
    await this.ensureDeviceId();
  }

  // First-run device-ID generation. Persists to settings only when
  // empty so existing IDs survive across loads.
  private async ensureDeviceId(): Promise<void> {
    if (this.settings.deviceId && this.settings.deviceId.length > 0) return;
    const hint =
      // @ts-ignore — Obsidian internal/Electron-only on desktop
      (typeof require === "function" && (() => {
        try {
          // @ts-ignore
          return require("os").hostname();
        } catch {
          return "device";
        }
      })()) || "device";
    this.settings.deviceId = generateDeviceId(hint);
    await this.saveSettings();
  }

  // Called from settings when the user switches backend OR when the
  // sidecar folder path changes. Migrates records from the old backend
  // into the new one (per-record, so partial failure is recoverable),
  // then refreshes open editors.
  async reinitBackend(previousBackend?: StorageBackend): Promise<{ migrated: number }> {
    const oldBackend = previousBackend ?? this.backend;
    const newBackend = this.buildBackend();
    let migrated = 0;
    try {
      const paths = await oldBackend.listAll();
      for (const notePath of paths) {
        const { raw } = await oldBackend.load(notePath);
        if (!raw) continue;
        const result = await newBackend.putRecord(notePath, raw);
        if (result.written) migrated++;
      }
    } catch (err) {
      console.warn("AiStyled-Authorship: backend migration encountered error", err);
    }
    this.backend = newBackend;
    this.conflictScanner = this.buildConflictScanner();
    this.lastPersisted.clear();
    this.hydrated.clear();
    this.warnedNearCap = false;
    await this.rehydrateAllOpen();
    return { migrated };
  }

  private get pluginFolderSidecarPath(): string {
    // 0.1.8 stored sidecars here; 0.1.9+ migrates them back to vault root.
    return normalizePath(`${this.app.vault.configDir}/plugins/${PLUGIN_ID}/authorship`);
  }

  private async migrateSidecarFolder() {
    // Migrations run on every load. We COPY (not move) and leave old
    // folders intact so the wizard can verify before cleanup. Idempotent
    // — sidecars already present in the target are skipped. After
    // migration we ensure the README is present.
    //
    //   .authorship/                             -> z-author-sync/   (very old)
    //   authorship/                              -> z-author-sync/   (0.1.9)
    //   <configDir>/plugins/<id>/authorship/     -> z-author-sync/   (0.1.8)
    //   previousSidecarFolderPath                -> current          (user-configured)
    const target = this.sidecarFolder;
    const legacyLocations = [
      LEGACY_DOT_FOLDER,
      LEGACY_VAULT_ROOT_FOLDER,
      this.pluginFolderSidecarPath,
    ];
    const previous = this.settings?.previousSidecarFolderPath;
    if (previous && normalizePath(previous) !== target) {
      legacyLocations.push(normalizePath(previous));
    }

    for (const src of legacyLocations) {
      await this.copySidecarsBetween(src, target);
    }

    await this.ensureSidecarReadme();
  }

  // Copies every sidecar file from src/ to dst/. Never moves; never
  // overwrites. Returns the number of files copied. Skips the sidecar
  // README from the source (it is regenerated in the target by
  // ensureSidecarReadme). No-op when src does not exist or is empty.
  async copySidecarsBetween(src: string, dst: string): Promise<number> {
    const adapter = this.app.vault.adapter;
    try {
      if (!(await adapter.exists(src))) return 0;
      const listing = await adapter.list(src);
      if (listing.files.length === 0) return 0;
      if (!(await adapter.exists(dst))) {
        await adapter.mkdir(dst);
      }
      let copied = 0;
      for (const oldPath of listing.files) {
        const filename = oldPath.split("/").pop();
        if (!filename) continue;
        if (filename === SIDECAR_README_FILENAME) continue;
        const newPath = normalizePath(`${dst}/${filename}`);
        try {
          if (await adapter.exists(newPath)) continue;
          const content = await adapter.read(oldPath);
          await adapter.write(newPath, content);
          copied++;
        } catch {
          // skip individual file errors
        }
      }
      if (copied > 0) {
        console.log(
          `AiStyled-Authorship: copied ${copied} sidecar(s) from ${src}/ to ${dst}/`
        );
      }
      return copied;
    } catch (err) {
      console.warn(`AiStyled-Authorship: sidecar copy from ${src}/ failed`, err);
      return 0;
    }
  }

  // Counts sidecar files at a given folder (excluding README). Used by
  // the settings UI to decide whether to show the migration banner.
  async countSidecarsAt(folder: string): Promise<number> {
    const adapter = this.app.vault.adapter;
    try {
      if (!(await adapter.exists(folder))) return 0;
      const listing = await adapter.list(folder);
      let n = 0;
      for (const p of listing.files) {
        const filename = p.split("/").pop();
        if (!filename || filename === SIDECAR_README_FILENAME) continue;
        n++;
      }
      return n;
    } catch {
      return 0;
    }
  }

  private async ensureSidecarReadme() {
    // Create (or refresh) the explainer README inside the sync folder.
    // Writes on every load so the instructions stay current if we change
    // them in a later version; users who edit their copy will see it
    // overwritten, which is acceptable for a plugin-owned explainer.
    const adapter = this.app.vault.adapter;
    const folder = this.sidecarFolder;
    const readmePath = normalizePath(`${folder}/${SIDECAR_README_FILENAME}`);
    try {
      if (!(await adapter.exists(folder))) {
        await adapter.mkdir(folder);
      }
      const existing = (await adapter.exists(readmePath))
        ? await adapter.read(readmePath)
        : null;
      if (existing !== SIDECAR_README_BODY) {
        await adapter.write(readmePath, SIDECAR_README_BODY);
      }
    } catch (err) {
      console.warn("AiStyled-Authorship: failed to write sidecar README", err);
    }
  }

  async loadSettings() {
    const loaded = (await this.loadData()) ?? {};
    this.settings = { ...DEFAULT_SETTINGS, ...loaded };
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.applyStylingToggle();
    this.refreshAllEditors();
  }

  applyStylingToggle() {
    document.body.classList.toggle(
      "leftcoast-ai-disabled",
      !this.settings.showAIStyling
    );
  }

  refreshAllEditors() {
    this.app.workspace.iterateAllLeaves(leaf => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) return;
      // @ts-ignore
      const cm: EditorView | undefined = (view.editor as any)?.cm;
      if (cm) {
        cm.dispatch({ effects: refreshDecorationsEffect.of(null) });
      }
    });
  }

  async onunload() {
    // Flush any pending writes synchronously-ish before unload
    for (const [, id] of this.writeTimers) window.clearTimeout(id);
    this.writeTimers.clear();
    document.body.classList.remove("leftcoast-ai-disabled");
    console.log("AiStyled-Authorship: unloaded");
  }
}

// ---- formatting helpers ----

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ---- delete-cache confirmation modal ----

class DeleteCacheModal extends Modal {
  constructor(
    app: App,
    private plugin: LeftcoastAuthorshipPlugin,
    private size: CacheSize,
    private onAfter: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl } = this;
    titleEl.setText("Delete all AI authorship cache?");

    const intro = contentEl.createEl("p");
    intro.appendText(
      `This will permanently delete all stored AI authorship ranges across `,
    );
    intro.createEl("strong", {
      text: `${this.size.fileCount} note${this.size.fileCount === 1 ? "" : "s"} (${formatBytes(this.size.bytes)})`,
    });
    intro.appendText(
      ". The text in your notes is unchanged, but the gradient styling will " +
        "disappear and cannot be recovered.",
    );

    const confirm = contentEl.createEl("p");
    confirm.appendText("Type ");
    confirm.createEl("strong", { text: "DELETE" });
    confirm.appendText(" below to confirm. This action cannot be undone.");

    const input = contentEl.createEl("input", { type: "text" });
    input.setAttr("placeholder", "DELETE");
    input.setAttr(
      "style",
      "width: 100%; margin: 0.5em 0 1em 0; padding: 6px 10px; " +
        "border: 1px solid var(--background-modifier-border); border-radius: 6px;",
    );

    const buttons = contentEl.createDiv();
    buttons.setAttr(
      "style",
      "display: flex; justify-content: flex-end; gap: 8px;",
    );

    const cancel = buttons.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());

    const remove = buttons.createEl("button", { text: "Delete cache" });
    remove.setAttr(
      "style",
      "background: var(--background-modifier-error); color: var(--text-on-accent);",
    );
    remove.disabled = true;

    input.addEventListener("input", () => {
      remove.disabled =
        input.value.trim().toUpperCase() !== "DELETE";
    });

    remove.addEventListener("click", async () => {
      remove.disabled = true;
      remove.setText("Deleting…");
      try {
        const { deleted } = await this.plugin.backend.deleteAll();
        // Reset in-memory state so the editor doesn't re-write what we just removed.
        // @ts-ignore — touching private fields by design
        this.plugin["lastPersisted"].clear();
        // @ts-ignore
        this.plugin["hydrated"].clear();
        // Strip ranges from open editors.
        for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
          const view = leaf.view;
          if (view instanceof MarkdownView) {
            // @ts-ignore
            const cm: EditorView | undefined = (view.editor as any)?.cm;
            if (cm) cm.dispatch({ effects: replaceAIRanges.of([]) });
          }
        }
        new Notice(`Deleted ${deleted} authorship record${deleted === 1 ? "" : "s"}.`);
        this.close();
        this.onAfter();
      } catch (err) {
        console.warn("AiStyled-Authorship: delete cache failed", err);
        new Notice("Failed to delete cache. Check the developer console.");
        remove.disabled = false;
        remove.setText("Delete cache");
      }
    });

    setTimeout(() => input.focus(), 50);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ---- Old-sidecar-folder cleanup modal ----
// Shown after "Migrate data now" succeeds. Scans the old folder; if every
// file looks like a sidecar (.md.json), offers a simple delete. If any
// file doesn't look like a sidecar, lists them and requires an explicit
// "I understand" checkbox before enabling the delete button.

class OldFolderCleanupModal extends Modal {
  constructor(
    app: App,
    private plugin: LeftcoastAuthorshipPlugin,
    private oldFolder: string,
    private onDone: () => void,
  ) {
    super(app);
  }

  async onOpen(): Promise<void> {
    const { contentEl, titleEl } = this;
    titleEl.setText("Delete old sidecar folder?");
    contentEl.empty();

    const listing = await this.scanFolder(this.oldFolder);
    if (!listing) {
      contentEl.createEl("p", {
        text: `Couldn't read the folder ${this.oldFolder}/. Nothing to clean up.`,
      });
      const row = contentEl.createDiv();
      row.setAttr(
        "style",
        "display: flex; justify-content: flex-end; gap: 8px; margin-top: 1em;",
      );
      const ok = row.createEl("button", { text: "OK" });
      ok.addEventListener("click", () => this.close());
      return;
    }

    const { sidecars, unknowns } = listing;

    const intro = contentEl.createEl("p");
    intro.appendText(`The old folder `);
    intro.createEl("strong", { text: this.oldFolder + "/" });
    intro.appendText(
      ` still exists. Your sidecars have already been copied to the new location — these are the leftovers.`,
    );

    const counts = contentEl.createEl("p");
    counts.appendText(
      `Found ${sidecars.length} sidecar file${sidecars.length === 1 ? "" : "s"}`,
    );
    if (unknowns.length > 0) {
      counts.createEl("strong", {
        text: ` and ${unknowns.length} non-sidecar file${unknowns.length === 1 ? "" : "s"}`,
      });
    }
    counts.appendText(".");

    let canDelete = unknowns.length === 0;

    if (unknowns.length > 0) {
      const warnBox = contentEl.createDiv();
      warnBox.setAttr(
        "style",
        "border: 1px solid var(--text-warning, #c0a030); border-radius: 6px; " +
          "padding: 10px 14px; margin: 0.5em 0 1em 0; " +
          "background-color: var(--background-secondary);",
      );
      const warnTitle = warnBox.createEl("strong", {
        text: "⚠ Non-sidecar files will also be deleted",
      });
      void warnTitle;
      const list = warnBox.createEl("ul");
      list.setAttr("style", "margin: 0.5em 0 0.5em 1em; max-height: 200px; overflow-y: auto;");
      for (const name of unknowns.slice(0, 50)) {
        list.createEl("li", { text: name });
      }
      if (unknowns.length > 50) {
        list.createEl("li", { text: `…and ${unknowns.length - 50} more` });
      }

      const confirmRow = contentEl.createEl("label");
      confirmRow.setAttr(
        "style",
        "display: flex; align-items: center; gap: 8px; margin: 0.5em 0 1em 0;",
      );
      const check = confirmRow.createEl("input", { type: "checkbox" });
      confirmRow.createSpan({
        text: "I understand these files will be permanently deleted.",
      });
      check.addEventListener("change", () => {
        canDelete = check.checked;
        deleteBtn.disabled = !canDelete;
      });
    }

    const buttons = contentEl.createDiv();
    buttons.setAttr(
      "style",
      "display: flex; justify-content: flex-end; gap: 8px; margin-top: 1em;",
    );

    const keep = buttons.createEl("button", { text: "Keep folder" });
    keep.addEventListener("click", () => this.close());

    const deleteBtn = buttons.createEl("button", {
      text: `Delete old folder`,
    });
    deleteBtn.setAttr(
      "style",
      "background: var(--background-modifier-error); color: var(--text-on-accent);",
    );
    deleteBtn.disabled = !canDelete;
    deleteBtn.addEventListener("click", async () => {
      if (!canDelete) return;
      deleteBtn.disabled = true;
      try {
        await this.app.vault.adapter.rmdir(this.oldFolder, true);
        new Notice(`Deleted old folder ${this.oldFolder}/.`);
      } catch (err) {
        new Notice(`Could not delete ${this.oldFolder}/. Check permissions.`);
      }
      this.close();
      this.onDone();
    });
  }

  private async scanFolder(
    folder: string,
  ): Promise<{ sidecars: string[]; unknowns: string[] } | null> {
    try {
      const listing = await this.app.vault.adapter.list(folder);
      const sidecars: string[] = [];
      const unknowns: string[] = [];
      for (const f of listing.files ?? []) {
        const name = f.split("/").pop() ?? f;
        if (name.endsWith(".md.json")) sidecars.push(name);
        else unknowns.push(name);
      }
      // Subfolders count as unknowns
      for (const d of listing.folders ?? []) {
        const name = d.split("/").pop() ?? d;
        unknowns.push(name + "/ (subfolder)");
      }
      return { sidecars, unknowns };
    } catch {
      return null;
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ---- folder-picker suggest ----

// Fuzzy-searchable vault-folder picker, using the modern
// AbstractInputSuggest API (Obsidian 1.4+). Mirrors the pattern used by
// notebook-navigator's FolderPathInputSuggest. Opens on click as well
// as on focus so the dropdown appears with no typed text. Caps results
// at 100.
class FolderSuggest extends AbstractInputSuggest<TFolder> {
  private static readonly LIMIT = 100;

  constructor(app: App, public inputEl: HTMLInputElement) {
    super(app, inputEl);
    inputEl.addEventListener("click", () => this.open());
  }

  getSuggestions(query: string): TFolder[] {
    const folders: TFolder[] = [];
    for (const f of this.app.vault.getAllLoadedFiles()) {
      if (f instanceof TFolder) folders.push(f);
    }
    const trimmed = query.trim();
    if (!trimmed) {
      return folders
        .sort((a, b) => a.path.localeCompare(b.path))
        .slice(0, FolderSuggest.LIMIT);
    }
    const match = prepareFuzzySearch(trimmed);
    const scored: { folder: TFolder; score: number }[] = [];
    for (const folder of folders) {
      const result = match(folder.path || "/");
      if (result) scored.push({ folder, score: result.score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, FolderSuggest.LIMIT).map(s => s.folder);
  }

  renderSuggestion(folder: TFolder, el: HTMLElement): void {
    const label = folder.path || "/";
    const query = this.inputEl.value.trim();
    if (query) {
      const result = prepareFuzzySearch(query)(label);
      if (result) {
        renderMatches(el, label, result.matches);
        return;
      }
    }
    el.setText(label);
  }

  selectSuggestion(folder: TFolder): void {
    this.inputEl.value = folder.path;
    this.inputEl.dispatchEvent(new Event("input"));
    this.close();
  }
}

// ---- settings tab ----

class AuthorshipSettingTab extends PluginSettingTab {
  plugin: LeftcoastAuthorshipPlugin;
  private aboutPreviewEl: HTMLElement | null = null;

  constructor(app: App, plugin: LeftcoastAuthorshipPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private detectSyncConfig(): {
    syncEnabled: boolean;
    otherTypesEnabled: boolean | null;
  } {
    try {
      // @ts-ignore — internal Obsidian API
      const syncPlugin = this.plugin.app.internalPlugins?.getPluginById?.("sync");
      if (!syncPlugin?.enabled) {
        console.warn("[AiStyled SYNC] sync plugin not enabled");
        return { syncEnabled: false, otherTypesEnabled: null };
      }
      // @ts-ignore
      const instance = syncPlugin.instance;
      console.warn("[AiStyled SYNC] sync plugin instance:", instance);
      console.warn("[AiStyled SYNC] instance keys:", instance ? Object.keys(instance) : "(none)");

      // Dump any object-typed config-ish property so we can see what's there
      const candidatePaths = [
        "pluginsMode", "syncOptions", "config", "options", "syncBinaries",
        "syncAttachments", "binaries", "other", "otherTypes", "types",
        "syncOtherFiles",
      ];
      for (const key of candidatePaths) {
        // @ts-ignore
        const val = instance?.[key];
        if (val !== undefined) {
          console.warn(`[AiStyled SYNC] instance.${key} =`, val);
        }
      }

      // Try shallow direct property (sync config is often flat)
      const directKeys = [
        "syncBinaries", "syncOtherFiles", "syncAttachments", "syncOther",
        "otherTypes", "allOther",
      ];
      for (const k of directKeys) {
        // @ts-ignore
        if (instance?.[k] !== undefined) {
          // @ts-ignore
          const v = !!instance[k];
          console.warn(`[AiStyled SYNC] detected direct ${k} =`, v);
          return { syncEnabled: true, otherTypesEnabled: v };
        }
      }

      // Try nested under common config objects
      const nestedContainers = [
        instance?.pluginsMode,
        instance?.syncOptions,
        instance?.config,
        instance?.options,
      ];
      const nestedKeys = [
        "syncBinaries", "syncOtherFiles", "syncAttachments", "binaries",
        "other", "otherTypes",
      ];
      for (const obj of nestedContainers) {
        if (obj && typeof obj === "object") {
          for (const k of nestedKeys) {
            if (k in obj) {
              const v = !!obj[k];
              console.warn(`[AiStyled SYNC] detected nested ${k} =`, v);
              return { syncEnabled: true, otherTypesEnabled: v };
            }
          }
        }
      }

      console.warn("[AiStyled SYNC] could not detect other-types setting");
      return { syncEnabled: true, otherTypesEnabled: null };
    } catch (err) {
      console.warn("[AiStyled SYNC] detect error:", err);
      return { syncEnabled: false, otherTypesEnabled: null };
    }
  }

  private isSidecarFolderHidden(): boolean {
    try {
      // @ts-ignore — internal Obsidian API
      const filters = this.plugin.app.vault.getConfig?.("userIgnoreFilters");
      if (!Array.isArray(filters)) return false;
      return filters.some(
        (f: unknown) => typeof f === "string" && f.includes(SIDECAR_FOLDER)
      );
    } catch {
      return false;
    }
  }

  private hideSidecarFolder() {
    try {
      // @ts-ignore — internal Obsidian API
      const existing = this.plugin.app.vault.getConfig?.("userIgnoreFilters");
      const asArray = Array.isArray(existing) ? existing.slice() : [];
      if (asArray.some((f: unknown) => typeof f === "string" && f.includes(SIDECAR_FOLDER))) return;
      asArray.push(`${SIDECAR_FOLDER}/`);
      // @ts-ignore — internal Obsidian API
      this.plugin.app.vault.setConfig?.("userIgnoreFilters", asArray);
    } catch (err) {
      console.warn("AiStyled-Authorship: failed to add folder to userIgnoreFilters", err);
    }
  }

  private renderInstallationInstructions() {
    const { containerEl } = this;
    const usingDataJson = this.plugin.settings.storageBackend === "dataJson";
    const { syncEnabled, otherTypesEnabled } = this.detectSyncConfig();
    const folderHidden = this.isSidecarFolderHidden();
    // When using data.json backend, sidecar-specific setup is N/A: no folder
    // to hide, no sync-type verification needed. Only the style-commands
    // section remains relevant.
    const syncProblem = usingDataJson
      ? false
      : syncEnabled && otherTypesEnabled === false;
    const setupComplete = usingDataJson ? true : folderHidden && !syncProblem;

    const details = containerEl.createEl("details");
    if (!setupComplete) details.setAttr("open", "");
    details.setAttr(
      "style",
      "margin-bottom: 18px; border: 1px solid var(--background-modifier-border); " +
        "border-radius: 6px; background: var(--background-secondary);"
    );

    const summary = details.createEl("summary");
    summary.setAttr(
      "style",
      "cursor: pointer; padding: 10px 14px; font-weight: 600; " +
        "display: flex; align-items: center; justify-content: space-between; gap: 8px;"
    );
    summary.createSpan({ text: "Installation instructions" });
    const statusTag = summary.createSpan();
    statusTag.setAttr(
      "style",
      "font-size: 0.82em; font-weight: 400; color: var(--text-muted);"
    );
    statusTag.setText(setupComplete ? "Setup complete ✓" : "Action needed");

    const body = details.createDiv();
    body.setAttr("style", "padding: 0 14px 14px 14px;");

    if (!usingDataJson) {
      this.renderHideFolderSection(body, folderHidden);
      this.renderSyncSetupSection(body, syncEnabled, otherTypesEnabled);
    }
    this.renderStyleCommandsSection(body);
  }

  private renderHideFolderSection(parent: HTMLElement, folderHidden: boolean) {
    const section = parent.createDiv();
    section.setAttr("style", "margin-bottom: 16px;");

    const h = section.createEl("h4");
    h.setAttr("style", "margin: 10px 0 6px 0;");
    h.setText(
      folderHidden
        ? "1. Hide the sync folder ✓"
        : "1. Hide the sync folder"
    );

    const p = section.createEl("p");
    p.setAttr("style", "margin: 0 0 8px 0; font-size: 0.9em;");
    if (folderHidden) {
      p.setText(
        "The z-author-sync/ folder is excluded from your file explorer. Sync still works normally."
      );
    } else {
      p.setText(
        "AI styling data lives in a z-author-sync/ folder at your vault root. " +
        "Hide it from the file explorer so it stays out of the way — this doesn't affect sync."
      );
      const btn = section.createEl("button");
      btn.setText("Hide z-author-sync/ folder");
      btn.setAttr("style", "margin: 0 0 6px 0;");
      btn.addEventListener("click", () => {
        this.hideSidecarFolder();
        this.display();
      });

      const alt = section.createEl("p");
      alt.setAttr("style", "margin: 6px 0 0 0; font-size: 0.85em; color: var(--text-muted);");
      alt.setText(
        "Or manually: Settings → Files and links → Excluded files → Add excluded folder → z-author-sync/. " +
        "Some file-management plugins (e.g. File Hider) also add a right-click Hide option to the file explorer."
      );
    }
  }

  private renderSyncSetupSection(
    parent: HTMLElement,
    syncEnabled: boolean,
    otherTypesEnabled: boolean | null
  ) {
    const section = parent.createDiv();
    section.setAttr("style", "margin-bottom: 16px;");

    const h = section.createEl("h4");
    h.setAttr("style", "margin: 10px 0 6px 0;");

    const p = section.createEl("p");
    p.setAttr("style", "margin: 0; font-size: 0.9em;");

    if (!syncEnabled) {
      h.setText("2. Sync setup");
      p.setText(
        "Obsidian Sync doesn't appear to be running. If you use iCloud Drive, Dropbox, or another " +
        "vault sync tool, the z-author-sync/ folder will sync automatically as part of your vault. " +
        "If you plan to use Obsidian Sync, enable \"Sync all other file types\" in " +
        "Settings → Core plugins → Sync on every device after you turn it on."
      );
    } else if (otherTypesEnabled === true) {
      h.setText("2. Sync setup ✓");
      p.setText(
        "Obsidian Sync is running and \"Sync all other file types\" is on. " +
        "Styling will sync across devices."
      );
    } else if (otherTypesEnabled === false) {
      h.setText("2. Enable \"Sync all other file types\"");
      p.setAttr(
        "style",
        "margin: 0; font-size: 0.9em; color: var(--text-error);"
      );
      p.setText(
        "Obsidian Sync is running, but \"Sync all other file types\" appears to be off. " +
        "Without it, the z-author-sync/ folder won't sync. " +
        "Enable it in Settings → Core plugins → Sync — on every device."
      );
    } else {
      h.setText("2. Verify \"Sync all other file types\"");
      p.setText(
        "Obsidian Sync is running, but I can't detect whether \"Sync all other file types\" is on. " +
        "For styling to sync across devices, make sure that setting is enabled in " +
        "Settings → Core plugins → Sync."
      );
    }
  }

  private renderStyleCommandsSection(parent: HTMLElement) {
    const section = parent.createDiv();

    const h = section.createEl("h4");
    h.setText("3. How to style text");
    h.setAttr("style", "margin: 10px 0 6px 0;");

    const p = section.createEl("p");
    p.setAttr("style", "margin: 0 0 8px 0; font-size: 0.9em;");
    p.setText(
      "Three commands are available via the command palette (Cmd/Ctrl+P) or a hotkey you assign in Settings → Hotkeys:"
    );

    const ul = section.createEl("ul");
    ul.setAttr("style", "margin: 0; padding-left: 20px; font-size: 0.9em;");
    const items: Array<[string, string]> = [
      ["Paste as AI", "pastes clipboard contents marked as AI-authored."],
      ["Mark selection as AI", "tags the currently selected text as AI."],
      ["Remove AI styling", "clears AI styling from the selection (or the current note if nothing is selected)."],
    ];
    for (const [name, desc] of items) {
      const li = ul.createEl("li");
      li.setAttr("style", "margin-bottom: 4px;");
      li.createEl("strong", { text: name });
      li.appendText(` — ${desc}`);
    }
  }

  private renderAboutPreview() {
    if (!this.aboutPreviewEl) return;
    this.aboutPreviewEl.empty();

    const texts: string[] = [
      "Authorship data is stored in a z-author-sync/ folder at the root of your vault (the z- prefix sorts it to the bottom of the file list). The folder syncs with Obsidian Sync (enable \"Sync all other file types\"), iCloud Drive, Dropbox, or any other vault sync tool — the gradient follows your notes across devices automatically.",
      "Typing inside AI-styled text produces normal characters. The gradient only survives where you haven't edited it — so the marker fades in proportion to how much of the text has come from you.",
      "A project of the Leviathan Duck from Leftcoast Media House Inc.",
    ];

    // Create spans first. Apply colors after the browser lays them out, so we
    // can read actual rendered positions and drive the real ribbon algorithm
    // (honoring orientation and waviness).
    const spans: HTMLSpanElement[] = [];
    for (const text of texts) {
      const p = this.aboutPreviewEl.createEl("p");
      for (const char of text) {
        const span = p.createSpan({ text: char });
        spans.push(span);
      }
    }

    requestAnimationFrame(() => this.applyPreviewColors(spans));
  }

  private applyPreviewColors(spans: HTMLSpanElement[]) {
    if (!this.aboutPreviewEl || spans.length === 0) return;

    const stops = stopsFromHex(this.plugin.settings.gradientStops);
    const orientation = this.plugin.settings.orientation;
    const waviness = this.plugin.settings.waviness;

    const containerRect = this.aboutPreviewEl.getBoundingClientRect();
    const containerLeft = containerRect.left;
    const containerTop = containerRect.top;
    const width = Math.max(1, containerRect.width);
    const height = Math.max(1, containerRect.height);

    const baseCenterX = width / 2;
    const baseCenterY = height / 2;
    const horizontalRadius = width / 2;
    const verticalRadius = height / 2;

    const firstRect = spans[0].getBoundingClientRect();
    const lineHeight = Math.max(firstRect.height, 16);
    const wavePeriod = Math.max(lineHeight, 24) * 15;
    const amp = width * 0.15 * waviness;

    for (const span of spans) {
      const r = span.getBoundingClientRect();
      const x = r.left - containerLeft + r.width / 2;
      const y = r.top - containerTop + r.height / 2;

      let d: number;
      if (orientation === "vertical") {
        const phase = (y / wavePeriod) * Math.PI * 2;
        const centerX = baseCenterX + Math.sin(phase) * amp;
        d = clamp(Math.abs(x - centerX) / horizontalRadius, 0, 1);
      } else {
        const phase = (x / wavePeriod) * Math.PI * 2;
        const centerY = baseCenterY + Math.sin(phase) * amp;
        d = clamp(Math.abs(y - centerY) / verticalRadius, 0, 1);
      }

      span.setAttr("style", `color: ${colorAt(stops, d)};`);
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderInstallationInstructions();

    containerEl.createEl("h3", { text: "Gradient colors" });

    const presetHint = containerEl.createEl("p");
    presetHint.setAttr("style", "color: var(--text-muted); font-size: 0.9em; margin-top: -0.4em;");
    presetHint.appendText("Pick a preset below, or customize each stop with the color pickers.");

    const presetRow = containerEl.createDiv();
    presetRow.setAttr(
      "style",
      "display: flex; flex-wrap: wrap; gap: 8px; margin: 0.5em 0 1em 0;"
    );

    for (const preset of GRADIENT_PRESETS) {
      const btn = presetRow.createEl("button", { text: preset.name });
      const gradientCSS = `linear-gradient(90deg, ${preset.stops.join(", ")})`;
      btn.setAttr(
        "style",
        `background: ${gradientCSS}; color: white; text-shadow: 0 1px 2px rgba(0,0,0,0.5); ` +
          "border: 1px solid var(--background-modifier-border); border-radius: 6px; " +
          "padding: 6px 12px; cursor: pointer; font-size: 0.9em; font-weight: 500;"
      );
      btn.addEventListener("click", async () => {
        this.plugin.settings.gradientStops = [...preset.stops];
        await this.plugin.saveSettings();
        this.display(); // re-render the settings tab so the color pickers update
      });
    }

    // Inline Reset button alongside the preset chicklets.
    const resetBtn = presetRow.createEl("button", { text: "Reset" });
    resetBtn.setAttr(
      "style",
      "border: 1px solid var(--background-modifier-border); border-radius: 6px; " +
        "padding: 6px 12px; cursor: pointer; font-size: 0.9em; " +
        "background: transparent; color: var(--text-muted);"
    );
    resetBtn.addEventListener("click", async () => {
      this.plugin.settings.gradientStops = [...DEFAULT_SETTINGS.gradientStops];
      await this.plugin.saveSettings();
      this.display();
    });

    const pickerRow = containerEl.createDiv();
    pickerRow.setAttr(
      "style",
      "display: flex; gap: 10px; align-items: center; margin: 0.5em 0 1em 0;"
    );
    const pickerLabel = pickerRow.createEl("span", { text: "Stops:" });
    pickerLabel.setAttr("style", "font-size: 0.9em; color: var(--text-muted);");

    for (let i = 0; i < this.plugin.settings.gradientStops.length; i++) {
      const input = pickerRow.createEl("input", { type: "color" });
      input.value = this.plugin.settings.gradientStops[i];
      input.setAttr(
        "style",
        "width: 36px; height: 36px; border: 1px solid var(--background-modifier-border); " +
          "border-radius: 6px; padding: 0; cursor: pointer; background: transparent;"
      );
      input.addEventListener("input", async () => {
        this.plugin.settings.gradientStops[i] = input.value.toUpperCase();
        await this.plugin.saveSettings();
        this.renderAboutPreview();
      });
    }

    // Live gradient preview using the About-style text. No heading, no hint.
    this.aboutPreviewEl = containerEl.createDiv();
    this.renderAboutPreview();

    containerEl.createEl("h3", { text: "Ribbon shape" });

    new Setting(containerEl)
      .setName("Orientation")
      .setDesc(
        "Vertical = ribbon runs top-to-bottom through the block with a left-right drift. Horizontal = ribbon runs left-to-right like a river, drifting up and down as you scan along."
      )
      .addDropdown(dropdown =>
        dropdown
          .addOption("vertical", "River (default)")
          .addOption("horizontal", "Sunset")
          .setValue(this.plugin.settings.orientation)
          .onChange(async value => {
            this.plugin.settings.orientation = value as GradientOrientation;
            await this.plugin.saveSettings();
            this.renderAboutPreview();
          })
      );

    new Setting(containerEl)
      .setName("Waviness")
      .setDesc(
        "How much the ribbon meanders. 0% = straight line, 100% = default drift, 200% = strong wave."
      )
      .addSlider(slider =>
        slider
          .setLimits(0, 600, 2)
          .setValue(Math.round(this.plugin.settings.waviness * 100))
          .setDynamicTooltip()
          .onChange(async value => {
            this.plugin.settings.waviness = value / 100;
            await this.plugin.saveSettings();
            this.renderAboutPreview();
          })
      );

    containerEl.createEl("h3", { text: "Right-click menu" });

    new Setting(containerEl)
      .setName('Show "Paste with AI Style"')
      .setDesc("Show the paste-as-AI item in the editor's right-click menu.")
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.showPasteMenuItem)
          .onChange(async value => {
            this.plugin.settings.showPasteMenuItem = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Show "Mark Selection as AI Style"')
      .setDesc("Show the mark-as-AI item in the right-click menu when text is selected.")
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.showMarkSelectionMenuItem)
          .onChange(async value => {
            this.plugin.settings.showMarkSelectionMenuItem = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Show "Remove AI Styling"')
      .setDesc("Show the remove-styling item in the right-click menu when AI-styled text is selected.")
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.showRemoveMenuItem)
          .onChange(async value => {
            this.plugin.settings.showRemoveMenuItem = value;
            await this.plugin.saveSettings();
          })
      );

    const paletteHint = containerEl.createEl("p");
    paletteHint.setAttr("style", "color: var(--text-muted); font-size: 0.9em;");
    paletteHint.appendText(
      "These toggles only affect the right-click menu. All three actions remain available from the command palette and via hotkeys you've assigned."
    );

    new Setting(containerEl)
      .setName("Show in reading mode")
      .setDesc(
        "Not yet available. Reading-mode gradient support is planned for a future release."
      )
      .setDisabled(true)
      .addToggle(toggle =>
        toggle
          .setValue(false)
          .setDisabled(true)
      );

    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc(
        "Log detailed rendering info to the developer console (Cmd+Option+I). Use the \"Dump debug info for current note\" command for a one-shot snapshot. Off for normal use."
      )
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.debug)
          .onChange(async value => {
            this.plugin.settings.debug = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Show AI authorship styling")
      .setDesc(
        "Display the gradient on AI-tagged text. When off, the gradient is hidden but authorship metadata is preserved — turn it back on to see the marker again."
      )
      .addToggle(toggle =>
        toggle
          .setValue(this.plugin.settings.showAIStyling)
          .onChange(async value => {
            this.plugin.settings.showAIStyling = value;
            await this.plugin.saveSettings();
          })
      );

    this.renderDataStorageSection(containerEl);

    // ---- Author block ----
    const authorBlock = containerEl.createDiv({ cls: "asa-author-block" });
    const nameDiv = authorBlock.createEl("div", { cls: "asa-author-name" });
    const nameLink = nameDiv.createEl("a", {
      text: "Leviathan Duck",
      href: "https://github.com/LeviathanDuck",
    });
    nameLink.setAttr("target", "_blank");
    nameLink.setAttr("rel", "noopener");
    authorBlock.createEl("div", {
      cls: "asa-author-meta",
      text: "Leftcoast Media House Inc.",
    });
    const moreDiv = authorBlock.createEl("div", { cls: "asa-author-meta" });
    const moreLink = moreDiv.createEl("a", {
      text: "More Obsidian plugins & themes",
      href: "https://github.com/LeviathanDuck?tab=repositories",
    });
    moreLink.setAttr("target", "_blank");
    moreLink.setAttr("rel", "noopener");
  }

  // --- Data storage section (bottom of the settings panel) ---

  // In-memory dismiss marker. When the user clicks "Leave in place" we
  // stop showing the migration banner for that specific old path until
  // they change the setting again. Not persisted — re-appears on reload
  // so they can still act on it.
  private dismissedMigrationFor: string | null = null;

  private renderDataStorageSection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: "Data storage" });

    const desc = containerEl.createEl("p");
    desc.setAttr(
      "style",
      "color: var(--text-muted); font-size: 0.9em; margin-top: -0.4em;"
    );
    desc.appendText(
      "Choose where this plugin stores its authorship records. The data.json " +
        "option (default) keeps everything in a single file inside the plugin " +
        "folder — simpler for most users. The sidecar folder option keeps " +
        "one JSON file per note alongside your vault, which scales better " +
        "and gives stronger multi-device sync behavior."
    );

    new Setting(containerEl)
      .setName("Storage backend")
      .setDesc(
        "data.json (default): all records in one file inside " +
          ".obsidian/plugins/aistyled-authorship/. Simple and works well " +
          "for most vaults. If you have hundreds or thousands of notes " +
          "with AI styling AND multiple devices editing simultaneously, " +
          "the sidecar option may be preferable — it scales as one small " +
          "file per note and uses per-note conflict isolation, so two " +
          "devices editing different notes offline can never lose each " +
          "other's data."
      )
      .addDropdown(drop =>
        drop
          .addOption("dataJson", "data.json (default)")
          .addOption("sidecar", "Sidecar folder (better at scale)")
          .setValue(this.plugin.settings.storageBackend)
          .onChange(async value => {
            const next = value as "sidecar" | "dataJson";
            if (next === this.plugin.settings.storageBackend) return;
            const previousBackend = this.plugin.backend;
            this.plugin.settings.storageBackend = next;
            await this.plugin.saveSettings();
            const { migrated } = await this.plugin.reinitBackend(previousBackend);
            new Notice(
              `Switched to ${next === "sidecar" ? "Sidecar folder" : "data.json"}. ` +
                `Migrated ${migrated} record${migrated === 1 ? "" : "s"}.`,
            );
            this.display();
          }),
      );

    if (this.plugin.settings.storageBackend === "sidecar") {
      this.renderSidecarFolderControls(containerEl);
    } else {
      this.renderDataJsonNotice(containerEl);
    }

    this.renderDeviceIdRow(containerEl);
    void this.renderCacheSizeAndDelete(containerEl);

    if (this.plugin.settings.storageBackend === "sidecar") {
      this.renderRescanConflictsRow(containerEl);
    }
  }

  private renderSidecarFolderControls(containerEl: HTMLElement): void {
    let warningEl!: HTMLElement;

    new Setting(containerEl)
      .setName("Sidecar folder")
      .setDesc(
        "Vault-relative path (e.g. z-author-sync or _meta/authorship). " +
          "Changing this doesn't move existing data automatically — use the " +
          "Migrate data now button below when you're ready.",
      )
      .addSearch(search => {
        new FolderSuggest(this.app, search.inputEl);
        search
          .setPlaceholder(DEFAULT_SETTINGS.sidecarFolderPath)
          .setValue(this.plugin.settings.sidecarFolderPath)
          .onChange(
            debounce((value: string) => {
              void this.validateAndSaveSidecarFolder(value, warningEl);
            }, 400, true),
          );
      });

    warningEl = containerEl.createDiv({ cls: "ai-styled-folder-warning" });
    warningEl.setAttr(
      "style",
      "display: none; color: var(--text-error); font-size: 0.85em; margin: -0.2em 0 0.6em 0;",
    );

    this.renderMigrationBanner(containerEl);
  }

  private renderDataJsonNotice(containerEl: HTMLElement): void {
    const note = containerEl.createDiv();
    note.setAttr(
      "style",
      "padding: 0.6em 0.8em; margin: 0.4em 0 0.8em 0; " +
        "border: 1px solid var(--background-modifier-border); border-radius: 6px; " +
        "background: var(--background-secondary); font-size: 0.9em;",
    );
    note.createEl("strong", { text: "data.json mode active (default). " });
    note.appendText(
      "Authorship records live in .obsidian/plugins/aistyled-authorship/data.json. " +
        "Works well for most vaults. Note: if you have hundreds or thousands of " +
        "notes with AI styling AND multiple devices editing simultaneously while " +
        "offline, the sync tool may overwrite the whole file with one device's " +
        "version, losing the other's changes. In that scenario the Sidecar folder " +
        "option is preferable — it stores one small file per note so devices " +
        "editing different notes never collide.",
    );
  }

  private renderDeviceIdRow(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Device ID")
      .setDesc(
        "Identifies this device in the event log so concurrent edits from " +
          "different devices can be merged correctly. Regenerate if you " +
          "cloned this vault from another device.",
      )
      .addText(text => {
        text.setValue(this.plugin.settings.deviceId);
        text.setDisabled(true);
      })
      .addButton(btn =>
        btn
          .setButtonText("Regenerate")
          .onClick(async () => {
            this.plugin.settings.deviceId = "";
            await this.plugin.saveSettings();
            // ensureDeviceId only writes when empty; the next call generates a fresh one
            await this.plugin.ensureDeviceIdPublic();
            this.display();
          }),
      );
  }

  private async renderCacheSizeAndDelete(containerEl: HTMLElement): Promise<void> {
    const placeholder = containerEl.createDiv();
    placeholder.setAttr("style", "min-height: 64px;");
    let size: CacheSize;
    try {
      size = await this.plugin.backend.cacheSize();
    } catch {
      size = { bytes: 0, fileCount: 0 };
    }
    placeholder.empty();

    const human = formatBytes(size.bytes);
    const cap = DATA_JSON_SIZE_CAP_BYTES;
    const pct = Math.min(100, Math.round((size.bytes / cap) * 100));
    const desc =
      this.plugin.settings.storageBackend === "dataJson"
        ? `${human} in data.json across ${size.fileCount} note${size.fileCount === 1 ? "" : "s"} (${pct}% of ${formatBytes(cap)} cap).`
        : `${human} across ${size.fileCount} sidecar file${size.fileCount === 1 ? "" : "s"}.`;

    new Setting(placeholder)
      .setName("Authorship cache size")
      .setDesc(desc)
      .addButton(btn =>
        btn
          .setButtonText("Delete cache")
          .setWarning()
          .onClick(() => {
            new DeleteCacheModal(this.app, this.plugin, size, () => this.display()).open();
          }),
      );
  }

  private renderRescanConflictsRow(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Sync conflicts")
      .setDesc(
        "Scan the sidecar folder for conflict copies created by Syncthing, " +
          "iCloud, Dropbox, OneDrive, or Obsidian Sync, then merge them by " +
          "newest-event-wins. Runs automatically on startup and when the " +
          "window regains focus.",
      )
      .addButton(btn =>
        btn
          .setButtonText("Rescan conflicts")
          .onClick(async () => {
            btn.setDisabled(true).setButtonText("Scanning…");
            const result = await this.plugin.conflictScanner.scanAll();
            btn.setDisabled(false).setButtonText("Rescan conflicts");
            const msg =
              result.merged > 0
                ? `Merged ${result.merged} conflict file${result.merged === 1 ? "" : "s"}.`
                : "No conflict files found.";
            new Notice(msg);
          }),
      );
  }

  private async renderMigrationBanner(containerEl: HTMLElement): Promise<void> {
    const previous = this.plugin.settings.previousSidecarFolderPath;
    if (!previous) return;
    const current = this.plugin.settings.sidecarFolderPath;
    if (normalizePath(previous) === normalizePath(current)) return;
    if (this.dismissedMigrationFor === previous) return;

    const count = await this.plugin.countSidecarsAt(previous);
    if (count === 0) {
      // Nothing to migrate — clear the stale pointer quietly.
      this.plugin.settings.previousSidecarFolderPath = null;
      await this.plugin.saveSettings();
      return;
    }

    const banner = containerEl.createDiv({ cls: "ai-styled-migration-banner" });
    banner.setAttr(
      "style",
      "display: flex; align-items: center; gap: 0.6em; flex-wrap: wrap; " +
        "padding: 0.6em 0.8em; margin-top: 0.4em; " +
        "border: 1px solid var(--background-modifier-border); border-radius: 6px; " +
        "background: var(--background-secondary);"
    );

    const msg = banner.createEl("span");
    msg.setText(
      `⚠ ${count} sidecar${count === 1 ? "" : "s"} still at old location: ${previous}/`
    );

    const migrateBtn = banner.createEl("button", { text: "Migrate data now" });
    migrateBtn.setAttr("style", "cursor: pointer;");
    migrateBtn.addEventListener("click", async () => {
      const copied = await this.plugin.copySidecarsBetween(
        previous,
        normalizePath(this.plugin.settings.sidecarFolderPath || DEFAULT_SETTINGS.sidecarFolderPath)
      );
      new Notice(
        `Copied ${copied} sidecar${copied === 1 ? "" : "s"} to ${normalizePath(this.plugin.settings.sidecarFolderPath || DEFAULT_SETTINGS.sidecarFolderPath)}/.`
      );
      this.plugin.settings.previousSidecarFolderPath = null;
      await this.plugin.saveSettings();
      // Offer to clean up the now-stale old folder.
      new OldFolderCleanupModal(
        this.app,
        this.plugin,
        previous,
        () => this.display(),
      ).open();
    });

    const leaveBtn = banner.createEl("button", { text: "Leave in place" });
    leaveBtn.setAttr("style", "cursor: pointer;");
    leaveBtn.addEventListener("click", () => {
      this.dismissedMigrationFor = previous;
      banner.remove();
    });
  }

  // Keystroke-level validation. Shows an inline warning when the path
  // is not inside the vault; does not save in that case. No Notice
  // toasts here — they would spam on every keystroke.
  private async validateAndSaveSidecarFolder(
    raw: string,
    warningEl: HTMLElement
  ): Promise<void> {
    const showWarning = (msg: string) => {
      warningEl.setText(msg);
      warningEl.style.display = "block";
    };
    const clearWarning = () => {
      warningEl.setText("");
      warningEl.style.display = "none";
    };

    const trimmed = raw.trim();

    // Absolute OS path check runs BEFORE slash-stripping — if the
    // original starts with / followed by a system-looking segment, or
    // a Windows drive letter, reject.
    if (/^\/(Users|home|var|tmp|etc|private|mnt|opt)\b/i.test(trimmed)) {
      showWarning("Path must be inside the vault (no absolute OS paths).");
      return;
    }
    if (/^[A-Za-z]:[\\/]/.test(trimmed)) {
      showWarning("Path must be inside the vault (no absolute drive paths).");
      return;
    }

    const stripped = trimmed.replace(/^\/+/u, "").replace(/\/+$/u, "");
    if (!stripped) {
      showWarning("Path cannot be empty. Sidecars cannot live at the vault root.");
      return;
    }

    const segments = stripped.split("/");
    if (segments.some(seg => seg === "..")) {
      showWarning("Path cannot contain `..` segments.");
      return;
    }

    const normalized = normalizePath(stripped);
    if (!normalized || normalized.startsWith("..")) {
      showWarning("Path must resolve to a location inside the vault.");
      return;
    }
    if (normalized === ".obsidian" || normalized.startsWith(".obsidian/")) {
      showWarning("Path cannot be inside the .obsidian config folder.");
      return;
    }

    clearWarning();

    const oldPath = this.plugin.settings.sidecarFolderPath;
    if (normalizePath(oldPath) === normalized) return;

    // Only stash the old path as "previous" if it actually has files
    // worth migrating. Otherwise the banner would appear with count 0
    // and immediately self-clear.
    const oldCount = await this.plugin.countSidecarsAt(oldPath);
    if (oldCount > 0) {
      this.plugin.settings.previousSidecarFolderPath = oldPath;
      this.dismissedMigrationFor = null;
    }
    this.plugin.settings.sidecarFolderPath = normalized;
    await this.plugin.saveSettings();
    this.display();
  }
}
