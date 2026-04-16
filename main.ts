import {
  App,
  Editor,
  MarkdownView,
  Menu,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  type DataAdapter,
} from "obsidian";
import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";

// ---- types ----

interface AIRange {
  from: number;
  to: number;
}

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

interface SidecarData {
  version: number;
  file: string;
  ranges: { from: number; to: number; author: "ai" }[];
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
    let next: AIRange[] = [];
    for (const range of ranges) {
      const from = tr.changes.mapPos(range.from, 1);
      const to = tr.changes.mapPos(range.to, -1);
      if (to > from) next.push({ from, to });
    }

    // Step 2: subtract every inserted/replaced region from all ranges.
    // This is what keeps "typing inside an AI range produces normal chars"
    // working. Any new characters carved out by changes become un-tagged.
    // `addAIRange` effects (step 3) re-add tagging for deliberate AI pastes.
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
        next = subtractInterval(next, effect.value.from, effect.value.to);
      }
    }

    // Normalize to merge any adjacent ranges produced by the combination of
    // mapping + subtraction + effects.
    return normalizeRanges(next);
  },
});

// ---- range helpers ----

function mergeRange(ranges: AIRange[], incoming: AIRange): AIRange[] {
  const all = [...ranges, incoming].sort((a, b) => a.from - b.from);
  const merged: AIRange[] = [];

  for (const range of all) {
    const last = merged[merged.length - 1];
    if (last && range.from <= last.to) {
      last.to = Math.max(last.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }

  return merged;
}

function subtractInterval(ranges: AIRange[], excFrom: number, excTo: number): AIRange[] {
  if (excTo <= excFrom) return ranges;
  const result: AIRange[] = [];
  for (const seg of ranges) {
    if (seg.to <= excFrom || seg.from >= excTo) {
      result.push(seg);
    } else {
      if (seg.from < excFrom) result.push({ from: seg.from, to: excFrom });
      if (seg.to > excTo) result.push({ from: excTo, to: seg.to });
    }
  }
  return result;
}

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

function normalizeRanges(ranges: AIRange[]): AIRange[] {
  let next: AIRange[] = [];
  for (const range of ranges) {
    if (!range || range.to <= range.from) continue;
    next = mergeRange(next, { from: range.from, to: range.to });
  }
  return next;
}

function sameRanges(a: AIRange[], b: AIRange[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].from !== b[i].from || a[i].to !== b[i].to) return false;
  }
  return true;
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
const SIDECAR_VERSION = 1;

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

function encodeSidecarPath(folder: string, notePath: string): string {
  const encoded = notePath.replace(/\//g, "__");
  return normalizePath(`${folder}/${encoded}.json`);
}

async function readSidecar(adapter: DataAdapter, sidecarPath: string): Promise<AIRange[]> {
  try {
    if (!(await adapter.exists(sidecarPath))) return [];
    const raw = await adapter.read(sidecarPath);
    const data = JSON.parse(raw) as Partial<SidecarData>;
    if (!data || !Array.isArray(data.ranges)) return [];
    const ranges: AIRange[] = [];
    for (const r of data.ranges) {
      if (r && typeof r.from === "number" && typeof r.to === "number" && r.to > r.from) {
        ranges.push({ from: r.from, to: r.to });
      }
    }
    return normalizeRanges(ranges);
  } catch (err) {
    console.warn(`AiStyled-Authorship: failed to read sidecar ${sidecarPath}`, err);
    return [];
  }
}

async function writeSidecar(
  adapter: DataAdapter,
  folder: string,
  sidecarPath: string,
  notePath: string,
  ranges: AIRange[]
): Promise<void> {
  try {
    if (ranges.length === 0) {
      console.warn("[AiStyled WRITE] ranges empty → skipping (never write empty)");
      return;
    }
    if (!(await adapter.exists(folder))) {
      console.warn("[AiStyled WRITE] creating sidecar folder:", folder);
      await adapter.mkdir(folder);
    }
    const data: SidecarData = {
      version: SIDECAR_VERSION,
      file: notePath,
      ranges: ranges.map(r => ({ from: r.from, to: r.to, author: "ai" as const })),
    };
    const json = JSON.stringify(data, null, 2);
    console.warn("[AiStyled WRITE] writing", sidecarPath, "→", json.length, "bytes,", ranges.length, "ranges");
    await adapter.write(sidecarPath, json);
    console.warn("[AiStyled WRITE] ✓ write succeeded:", sidecarPath);
  } catch (err) {
    console.warn("[AiStyled WRITE] ✗ write FAILED:", sidecarPath, err);
  }
}

async function deleteSidecar(adapter: DataAdapter, sidecarPath: string): Promise<void> {
  try {
    if (await adapter.exists(sidecarPath)) {
      await adapter.remove(sidecarPath);
    }
  } catch (err) {
    console.warn(`AiStyled-Authorship: failed to delete sidecar ${sidecarPath}`, err);
  }
}

async function moveSidecar(
  adapter: DataAdapter,
  folder: string,
  fromPath: string,
  toPath: string
): Promise<void> {
  try {
    if (!(await adapter.exists(fromPath))) return;
    const raw = await adapter.read(fromPath);
    if (!(await adapter.exists(folder))) {
      await adapter.mkdir(folder);
    }
    await adapter.write(toPath, raw);
    await adapter.remove(fromPath);
  } catch (err) {
    console.warn(`AiStyled-Authorship: failed to move sidecar ${fromPath} -> ${toPath}`, err);
  }
}

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

  async onload() {
    await this.loadSettings();

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

    // Rename hook — move the sidecar with the note
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (file instanceof TFile) {
          const folder = this.sidecarFolder;
          void moveSidecar(
            this.app.vault.adapter,
            folder,
            encodeSidecarPath(folder, oldPath),
            encodeSidecarPath(folder, file.path)
          );
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

    // Sidecar arrived via sync — merge its ranges with the current editor
    // state (union). This way ranges from other devices are ADDED to this
    // device's ranges, not replace-or-skip. Supports multi-device editing
    // where each device adds its own AI styling.
    const onSidecarTouched = (filePath: string) => {
      if (!filePath.startsWith(SIDECAR_FOLDER + "/")) return;
      const filename = filePath.slice(SIDECAR_FOLDER.length + 1);
      if (filename === SIDECAR_README_FILENAME) return;
      if (!filename.endsWith(".json")) return;
      const encoded = filename.slice(0, -5);
      const notePath = encoded.replace(/__/g, "/");
      const noteFile = this.app.vault.getAbstractFileByPath(notePath);
      if (!(noteFile instanceof TFile)) return;
      void this.mergeSidecarIntoView(noteFile);
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

    // Delete hook — drop the sidecar
    this.registerEvent(
      this.app.vault.on("delete", file => {
        if (file instanceof TFile) {
          void deleteSidecar(this.app.vault.adapter, encodeSidecarPath(this.sidecarFolder, file.path));
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

  private async mergeSidecarIntoView(file: TFile) {
    const ranges = await readSidecar(
      this.app.vault.adapter,
      encodeSidecarPath(this.sidecarFolder, file.path)
    );
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
    // onRangesMaybeChanged). We always attempt to load from the sidecar
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

    const ranges = await readSidecar(
      this.app.vault.adapter,
      encodeSidecarPath(this.sidecarFolder, file.path)
    );

    if (ranges.length === 0) {
      // No sidecar. Mark hydrated — writes are allowed if the user adds
      // ranges later.
      this.hydrated.add(file.path);
      return;
    }

    const current = view.state.field(aiRangeField, false) ?? [];
    // Union: keep whatever the editor already has AND add the sidecar's
    // ranges. Handles multi-device case where the local state might have
    // been populated by earlier sync events or a previous session.
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

    // Never write empty ranges. An empty field is usually a transient state
    // (editor just created, hydration pending). Writing [] would delete the
    // sidecar and race with hydration. Sidecars are only deleted when the
    // NOTE is deleted (vault delete hook), not when the field is empty.
    if (normalized.length === 0) {
      console.warn("[AiStyled PERSIST] → skipped: empty ranges (never write empty)");
      return;
    }

    if (!this.hydrated.has(path)) {
      console.warn("[AiStyled PERSIST] → marking hydrated (non-empty write)");
      this.hydrated.add(path);
    }

    const last = this.lastPersisted.get(path);
    if (last && sameRanges(last, normalized)) {
      console.warn("[AiStyled PERSIST] → skipped: same as lastPersisted");
      return;
    }
    console.warn("[AiStyled PERSIST] → scheduling sidecar write for", path, "with", normalized.length, "ranges");
    this.scheduleSidecarWrite(path, normalized);
  }

  private scheduleSidecarWrite(notePath: string, ranges: AIRange[]) {
    const existing = this.writeTimers.get(notePath);
    if (existing !== undefined) window.clearTimeout(existing);
    const timerId = window.setTimeout(() => {
      this.writeTimers.delete(notePath);
      console.warn("[AiStyled PERSIST] debounce fired for", notePath, "→ flushing", ranges.length, "ranges");
      void this.flushSidecar(notePath, ranges);
    }, WRITE_DEBOUNCE_MS);
    this.writeTimers.set(notePath, timerId);
  }

  private async flushSidecar(notePath: string, ranges: AIRange[]) {
    const folder = this.sidecarFolder;
    const sidecarPath = encodeSidecarPath(folder, notePath);
    console.warn("[AiStyled PERSIST] flushSidecar:", sidecarPath, "ranges:", ranges.length);
    await writeSidecar(this.app.vault.adapter, folder, sidecarPath, notePath, ranges);
    console.warn("[AiStyled PERSIST] writeSidecar completed for", sidecarPath);
    this.lastPersisted.set(notePath, ranges);
  }

  private get sidecarFolder(): string {
    return SIDECAR_FOLDER;
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
    const adapter = this.app.vault.adapter;
    const target = this.sidecarFolder;
    const legacyLocations = [
      LEGACY_DOT_FOLDER,
      LEGACY_VAULT_ROOT_FOLDER,
      this.pluginFolderSidecarPath,
    ];

    for (const src of legacyLocations) {
      try {
        if (!(await adapter.exists(src))) continue;
        const listing = await adapter.list(src);
        if (listing.files.length === 0) continue;
        if (!(await adapter.exists(target))) {
          await adapter.mkdir(target);
        }
        let copied = 0;
        for (const oldPath of listing.files) {
          const filename = oldPath.split("/").pop();
          if (!filename) continue;
          // Never migrate the README from an old location.
          if (filename === SIDECAR_README_FILENAME) continue;
          const newPath = normalizePath(`${target}/${filename}`);
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
            `AiStyled-Authorship: copied ${copied} sidecar(s) from ${src}/ to ${target}/`
          );
        }
      } catch (err) {
        console.warn(`AiStyled-Authorship: sidecar migration from ${src}/ failed`, err);
      }
    }

    await this.ensureSidecarReadme();
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
    const { syncEnabled, otherTypesEnabled } = this.detectSyncConfig();
    const folderHidden = this.isSidecarFolderHidden();
    const syncProblem = syncEnabled && otherTypesEnabled === false;
    const setupComplete = folderHidden && !syncProblem;

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

    this.renderHideFolderSection(body, folderHidden);
    this.renderSyncSetupSection(body, syncEnabled, otherTypesEnabled);
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

  }
}
