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
  rangeTop: number;
  radius: number;
  waveAmplitude: number;
  wavePeriod: number;
}

interface SidecarData {
  version: number;
  file: string;
  ranges: { from: number; to: number; author: "ai" }[];
}

// ---- settings ----

interface AuthorshipSettings {
  showAIStyling: boolean;
  showPasteMenuItem: boolean;
  showMarkSelectionMenuItem: boolean;
  showRemoveMenuItem: boolean;
  gradientStops: string[];
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

const SIDECAR_FOLDER = ".authorship";
const SIDECAR_VERSION = 1;

function encodeSidecarPath(notePath: string): string {
  const encoded = notePath.replace(/\//g, "__");
  return normalizePath(`${SIDECAR_FOLDER}/${encoded}.json`);
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
  sidecarPath: string,
  notePath: string,
  ranges: AIRange[]
): Promise<void> {
  try {
    if (ranges.length === 0) {
      if (await adapter.exists(sidecarPath)) {
        await adapter.remove(sidecarPath);
      }
      return;
    }
    if (!(await adapter.exists(SIDECAR_FOLDER))) {
      await adapter.mkdir(SIDECAR_FOLDER);
    }
    const data: SidecarData = {
      version: SIDECAR_VERSION,
      file: notePath,
      ranges: ranges.map(r => ({ from: r.from, to: r.to, author: "ai" as const })),
    };
    await adapter.write(sidecarPath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.warn(`AiStyled-Authorship: failed to write sidecar ${sidecarPath}`, err);
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
  fromPath: string,
  toPath: string
): Promise<void> {
  try {
    if (!(await adapter.exists(fromPath))) return;
    const raw = await adapter.read(fromPath);
    if (!(await adapter.exists(SIDECAR_FOLDER))) {
      await adapter.mkdir(SIDECAR_FOLDER);
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

function buildGradientField(view: EditorView, rangeFrom: number): GradientField {
  const viewportRect = view.scrollDOM.getBoundingClientRect();
  const horizontalInset = Math.max(view.defaultCharacterWidth * 2, 24);
  const fieldLeft = viewportRect.left + horizontalInset;
  const fieldRight = viewportRect.right - horizontalInset;
  const fieldWidth = Math.max(fieldRight - fieldLeft, view.defaultCharacterWidth * 8);
  const lineBlock = view.lineBlockAt(rangeFrom);

  return {
    baseCenterX: fieldLeft + fieldWidth / 2,
    rangeTop: lineBlock.top,
    radius: fieldWidth / 2,
    waveAmplitude: clamp(fieldWidth * 0.02, 8, 18),
    wavePeriod: Math.max(lineBlock.height, 24) * 8,
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
  getStops: () => Stop[]
) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }

      update(update: ViewUpdate) {
        const rangesChanged =
          update.state.field(aiRangeField, false) !==
          update.startState.field(aiRangeField, false);

        const refreshRequested = update.transactions.some(tr =>
          tr.effects.some(e => e.is(refreshDecorationsEffect))
        );

        if (
          update.docChanged ||
          update.viewportChanged ||
          rangesChanged ||
          refreshRequested
        ) {
          this.decorations = this.build(update.view);
        }

        if (rangesChanged || update.docChanged) {
          onRangesMaybeChanged(update.view);
        }
      }

      build(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();
        const ranges = view.state.field(aiRangeField, false) ?? [];
        const docLength = view.state.doc.length;
        const stops = getStops();

        for (const range of ranges) {
          const from = Math.max(0, range.from);
          const to = Math.min(docLength, range.to);
          if (to <= from) continue;

          const field = buildGradientField(view, from);
          for (const slice of buildVisibleSlices(view, { from, to })) {
            let cursor = slice.from;
            while (cursor <= slice.to && cursor <= docLength) {
              const block = view.lineBlockAt(cursor);
              const segFrom = Math.max(block.from, slice.from);
              const segTo = Math.min(block.to, slice.to);

              if (segTo > segFrom) {
                const centerX = rowCenterX(field, block.top);
                const blockLen = Math.max(1, block.to - block.from);
                const fieldLeft = field.baseCenterX - field.radius;
                const fieldSpan = field.radius * 2;
                for (let pos = segFrom; pos < segTo; pos++) {
                  const chunkEnd = pos + 1;
                  const normalized = (pos - block.from) / blockLen;
                  const x = fieldLeft + normalized * fieldSpan;
                  const d = clamp(Math.abs(x - centerX) / field.radius, 0, 1);
                  builder.add(pos, chunkEnd, buildLineDecoration(colorAt(stops, d)));
                }
              }

              if (block.to >= slice.to) break;
              cursor = block.to + 1;
            }
          }
        }

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
  settings: AuthorshipSettings = { ...DEFAULT_SETTINGS };

  async onload() {
    await this.loadSettings();

    this.registerEditorExtension([
      aiRangeField,
      clipboardHandlers,
      createHighlightPlugin(
        view => this.onRangesMaybeChanged(view),
        () => stopsFromHex(this.settings.gradientStops)
      ),
    ]);

    this.addSettingTab(new AuthorshipSettingTab(this.app, this));
    this.applyStylingToggle();

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
                .setIcon("wand")
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
          void moveSidecar(
            this.app.vault.adapter,
            encodeSidecarPath(oldPath),
            encodeSidecarPath(file.path)
          );
          const cached = this.lastPersisted.get(oldPath);
          if (cached) {
            this.lastPersisted.set(file.path, cached);
            this.lastPersisted.delete(oldPath);
          }
        }
      })
    );

    // Delete hook — drop the sidecar
    this.registerEvent(
      this.app.vault.on("delete", file => {
        if (file instanceof TFile) {
          void deleteSidecar(this.app.vault.adapter, encodeSidecarPath(file.path));
          this.lastPersisted.delete(file.path);
          const pending = this.writeTimers.get(file.path);
          if (pending !== undefined) {
            window.clearTimeout(pending);
            this.writeTimers.delete(file.path);
          }
        }
      })
    );

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

  private async hydrateFile(file: TFile) {
    // If a write is pending, in-memory state is authoritative — don't overwrite it.
    if (this.writeTimers.has(file.path)) return;

    const view = this.findEditorView(file);
    if (!view) return;

    const current = view.state.field(aiRangeField, false) ?? [];
    if (current.length > 0) return; // already populated for this session

    const ranges = await readSidecar(this.app.vault.adapter, encodeSidecarPath(file.path));
    if (ranges.length === 0) return;

    // Dispatch out-of-band so we don't run during a host update cycle.
    queueMicrotask(() => {
      // Re-check the view is still live and for the same file
      const liveView = this.findEditorView(file);
      if (!liveView) return;
      liveView.dispatch({ effects: replaceAIRanges.of(ranges) });
      this.lastPersisted.set(file.path, ranges);
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
    if (!path) return;
    const ranges = view.state.field(aiRangeField, false) ?? [];
    const normalized = normalizeRanges(ranges);
    const last = this.lastPersisted.get(path);
    if (last && sameRanges(last, normalized)) return;
    this.scheduleSidecarWrite(path, normalized);
  }

  private scheduleSidecarWrite(notePath: string, ranges: AIRange[]) {
    const existing = this.writeTimers.get(notePath);
    if (existing !== undefined) window.clearTimeout(existing);
    const timerId = window.setTimeout(() => {
      this.writeTimers.delete(notePath);
      void this.flushSidecar(notePath, ranges);
    }, WRITE_DEBOUNCE_MS);
    this.writeTimers.set(notePath, timerId);
  }

  private async flushSidecar(notePath: string, ranges: AIRange[]) {
    const sidecarPath = encodeSidecarPath(notePath);
    await writeSidecar(this.app.vault.adapter, sidecarPath, notePath, ranges);
    this.lastPersisted.set(notePath, ranges);
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

  private renderAboutPreview() {
    if (!this.aboutPreviewEl) return;
    this.aboutPreviewEl.empty();

    const stops = stopsFromHex(this.plugin.settings.gradientStops);
    const texts: string[] = [
      "Authorship data is stored in a .authorship/ folder at the root of your vault. The folder syncs with Obsidian Sync, iCloud Drive, Dropbox, or any other vault sync tool — the gradient follows your notes across devices automatically.",
      "Typing inside AI-styled text produces normal characters. The gradient only survives where you haven't edited it — so the marker fades in proportion to how much of the text has come from you.",
      "A project of the Leviathan Duck from Leftcoast Media House Inc.",
    ];

    for (const text of texts) {
      const p = this.aboutPreviewEl.createEl("p");
      const n = text.length;
      const center = (n - 1) / 2;
      for (let i = 0; i < n; i++) {
        const dist = Math.abs(i - center);
        const d = center === 0 ? 0 : dist / center;
        const color = colorAt(stops, d);
        const span = p.createSpan({ text: text[i] });
        span.setAttr("style", `color: ${color};`);
      }
    }
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

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

    new Setting(containerEl)
      .setName("Reset gradient to default")
      .setDesc("Restore the Cascade preset (pink ↔ blue).")
      .addButton(btn =>
        btn.setButtonText("Reset").onClick(async () => {
          this.plugin.settings.gradientStops = [...DEFAULT_SETTINGS.gradientStops];
          await this.plugin.saveSettings();
          this.display();
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

    containerEl.createEl("h3", { text: "About" });

    const previewHint = containerEl.createEl("p");
    previewHint.setAttr("style", "color: var(--text-muted); font-size: 0.85em; margin-top: -0.4em;");
    previewHint.appendText(
      "Live preview — the text below is rendered with the current gradient. Change the stops above and watch it update."
    );

    this.aboutPreviewEl = containerEl.createDiv();
    this.renderAboutPreview();
  }
}
