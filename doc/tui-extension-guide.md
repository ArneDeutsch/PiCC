# PiCC TUI extension guide

A reference for anyone adding or changing **terminal-UI behavior** in PiCC — custom tool
rendering, colors/themes, interactive panes, progress indicators, and keybindings. It records
what Pi's extension API makes possible, how hard each thing is, and what to avoid, so we don't
have to re-derive it from `node_modules` every time.

For the broader integration contracts see [`doc/design/pi-integration.md`](pi-integration.md);
for the module map see [`doc/architecture.md`](architecture.md). This guide is the TUI-specific
companion to both.

> **Baseline:** Pi `@earendil-works/pi-*` `^0.80.6` (the version pinned in `package.json`). The
> authoritative source for everything below is
> `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` (the extension
> API) and `.../dist/modes/interactive/theme/theme.d.ts` (the theme model). When Pi is upgraded,
> re-verify against those files — this is a pre-1.0 surface and it moves.

---

## 1. The one mental model

**PiCC is a Pi extension, not a fork of Pi's renderer.** The entry point is
`export default function picc(pi)` in `src/index.ts`, where `pi` is Pi's `ExtensionAPI`. PiCC
does **not** own the render loop, the scrollback model, or the terminal — it hangs behavior off
the hooks Pi exposes.

So the ceiling on "how adaptable is the TUI" is exactly **the extension API surface**. Anything
inside that API is fair game and upgrade-stable-ish. Anything outside it means patching or
forking `pi-coding-agent`, which breaks the "minimal harness on top of an unmodified Pi" model
and is fragile across Pi bumps — treat it as out of scope unless there is no alternative.

Two objects matter:

- **`pi` — the `ExtensionAPI`.** Registration and session-level actions: `pi.on(event, …)`,
  `pi.registerTool`, `pi.registerCommand`, `pi.registerShortcut`, `pi.registerMessageRenderer`,
  `pi.registerEntryRenderer`, `pi.sendMessage`, `pi.appendEntry`, `pi.setModel`, …
- **`ctx.ui` — the `ExtensionUIContext`.** The actual UI verbs: `ctx.ui.custom`,
  `ctx.ui.setWidget`, `ctx.ui.setFooter/setHeader`, `ctx.ui.setStatus`,
  `ctx.ui.setWorkingIndicator`, `ctx.ui.setTheme`, `ctx.ui.notify`, `ctx.ui.onTerminalInput`, …

### 1.1 Two caveats that gate almost everything

1. **Mode-gating — interactive UI is TUI-only.** `ctx.mode` is one of `"tui" | "rpc" | "json" |
   "print"`. Every interactive verb (`custom`, widgets, footer/header, shortcuts, raw input,
   spinner) only does something in `"tui"`. PiCC also runs headless (print/RPC), so **always
   guard**: check `ctx.mode === "tui"` (or `ctx.hasUI` for dialog-capable modes, which is true in
   TUI *and* RPC) and provide a text-mode degrade. Never let UI code throw into a headless run.

2. **You need a `ctx`, and you only get one at specific entry points.** UI verbs live on `ctx.ui`,
   and a `ctx` is only handed to you inside:
   - **event handlers** — `pi.on("session_start", (event, ctx) => …)` etc.,
   - **tool `execute`** — the 5th argument (`execute(id, params, signal, onUpdate, ctx)`),
   - **command handlers** — `pi.registerCommand(name, { handler(args, ctx) })` (gets the richer
     `ExtensionCommandContext`).

   Persistent chrome (a widget, a custom footer) is *installed* from one of these entry points and
   then lives on until cleared. There is no "global `ui` you can touch any time" — capture it when
   you have it, or drive everything from a command/event.

---

## 2. Capability map (what's easy, hard, impossible)

| Goal | Verdict | Mechanism |
|---|---|---|
| Custom framing of **our own** tool call/result | **Easy** | `renderCall`/`renderResult` + `renderShell: "self"` on the `ToolDefinition` |
| Remove blank lines / gutter around a tool row | **Easy (own tools) · Medium (built-ins) · Impossible (global)** | `renderShell: "self"` bypasses the standard shell; built-ins need re-registration; inter-block spacing is render-loop-internal |
| Colors in our own components | **Easy** | `theme.fg("<slot>", text)`, `theme.bg`, `theme.bold/italic/...`, or raw ANSI |
| Re-skin the whole UI / switch themes | **Medium** | `ctx.ui.setTheme`, `new Theme(...)`, ship theme JSON via `resources_discover` |
| Add a **new named color role** | **Impossible** | `ThemeColor` union is closed |
| New interactive pane (subagent-view, picker, navigator) | **Possible · Medium effort** | `ctx.ui.custom(factory, { overlay, overlayOptions, onHandle })` |
| Persistent pane above/below the editor | **Easy–Medium** | `ctx.ui.setWidget(key, content \| factory, { placement })` |
| Custom header / footer | **Medium** | `ctx.ui.setHeader` / `ctx.ui.setFooter` |
| Progress indicators / spinners / status | **Easy** | `setWorkingIndicator`, `setWorkingMessage`, `setWorkingVisible`, `setStatus`, per-tool `onUpdate` |
| Live in-tool progress (streaming) | **Easy (already done)** | tool `onUpdate` + `renderResult(isPartial)` — see `src/runtime/subagent-render.ts` |
| Add a new global keyboard shortcut | **Easy** | `pi.registerShortcut(keyId, { handler })` |
| Own the keys inside our own overlay/component | **Easy** | handle input in the component via the injected `KeybindingsManager` |
| Rebind an **existing Pi action** (Esc, Ctrl-O, …) from code | **Not exposed / Hard** | user's `keybindings.json` only; from code you can only *intercept* (`onTerminalInput`) or replace the editor |
| Custom transcript entries / messages | **Easy (entries already done)** | `pi.registerEntryRenderer` / `pi.registerMessageRenderer` |
| Slash commands, CLI flags, terminal title, autocomplete | **Easy** | `pi.registerCommand`, `pi.registerFlag`, `ctx.ui.setTitle`, `ctx.ui.addAutocompleteProvider` |
| Global transcript layout / spacing / scrollback | **Impossible (without forking Pi)** | render-loop internal |

---

## 3. Tool rendering (the workhorse)

This is the most-used and best-understood surface. The canonical example is
`src/runtime/subagent-render.ts` (Agent / TaskOutput renderers) — read it before writing a new
one; it encodes hard-won invariants.

### 3.1 The contract

A `ToolDefinition` (see `types.d.ts` ~line 335) may supply:

```ts
renderCall?:   (args, theme, ctx) => Component
renderResult?: (result, options, theme, ctx) => Component
renderShell?:  "default" | "self"
```

A **Component** is the structural pi-tui contract: `{ render(width: number): string[] }`. PiCC's
renderers use the untyped structural form, so no pi-tui type import is needed — but the `theme`
argument **is** Pi's `Theme` (see §4).

- `options` for `renderResult` is `{ expanded: boolean; isPartial: boolean }`. `isPartial` is the
  streaming case (a live, not-yet-final result); render the rolling/partial view then.
- `ctx` is a `ToolRenderContext` (args, `toolCallId`, `invalidate()`, `expanded`, `isError`,
  `cwd`, …) — use `invalidate()` to force a redraw of just that row.

### 3.2 `renderShell` — this is how you control blank lines and framing

`ToolExecutionComponent` (in `dist/modes/interactive/components/tool-execution.js`) wraps a tool
row in a standard **colored shell** (`contentBox`) that provides the gutter, padding, and the
leading/trailing spacing you see around every tool. Setting `renderShell: "self"` swaps that for
a bare `selfRenderContainer` and hands *all* framing to your component — you emit exactly the
lines you want, no more, no less (confirmed at `tool-execution.js:181`).

- **To drop the blank lines at the start/end of one of our tools:** give it `renderShell: "self"`
  and return precisely the lines you want from `render(width)`.
- **To do the same for a built-in** (`bash`/`read`/`edit`/…): PiCC already re-registers these for
  cwd-swap (`src/index.ts`, the "Cwd-swapping overrides" block) but currently **inherits** their
  renderers by omitting `renderCall`/`renderResult`. To take over framing, supply your own
  renderers + `renderShell: "self"` on the re-registered tool. Cost: you now own that tool's whole
  display, including diffs/truncation the built-in used to give you for free — only do it if the
  reskin is worth it.
- **The blank line Pi inserts *between* transcript blocks is not yours.** That is render-loop
  layout, not a tool concern. No extension knob changes it. Plan around it.

### 3.3 Rules to copy from `subagent-render.ts`

These are not style preferences — violating them crashes the app or leaks terminal control:

1. **Width is a hard contract.** pi-tui throws an `uncaughtException` (kills the process) if any
   rendered line's *visible* width exceeds `width`. Measure with pi-tui's own
   `visibleWidth`/`truncateToWidth`/`wrapTextWithAnsi` (grapheme + East-Asian-width + tabs=3), not
   `String.length`. Always run a final clamp pass over every line you return (`clampLines`).
2. **Sanitize model-/file-supplied text before it reaches the terminal.** Tool args, subagent
   output, file contents can carry ANSI/OSC/control sequences. Strip them
   (`sanitizeProgressText` / `sanitizeLine` in `src/runtime/subagent-progress.ts`) *before* the
   width clamp (the clamp preserves ANSI verbatim — it is a width tool, not a sanitizer). This is
   **security, not cosmetics**: unsanitized text lets a hostile file inject escape sequences into
   the parent terminal.
3. **Null-guard the theme.** In print/RPC or a future themeless path, `theme` may be absent or
   partial. Access it through helpers (`themedFg`, `themedBold`) that fall back to plain text, so a
   renderer can never throw into Pi's render loop.
4. **Never mutate `result.content`.** The model reads `result.content` verbatim; the human view is
   a *local* transformed copy. Build a display string, don't edit the source.

---

## 4. Colors and themes

### 4.1 The model

`Theme` (`dist/modes/interactive/theme/theme.d.ts`) is a fixed vocabulary of **semantic color
slots**, not a free palette:

- `ThemeColor` (~50 slots): `accent`, `border`, `success`, `error`, `warning`, `muted`, `dim`,
  `text`, `toolTitle`, `toolOutput`, `mdHeading`, `mdCode`, `mdCodeBlock`, `toolDiffAdded`,
  `toolDiffRemoved`, `syntaxKeyword`/`syntaxString`/… , `thinkingLow`…`thinkingMax`, `bashMode`, …
- `ThemeBg` (~6 slots): `selectedBg`, `userMessageBg`, `toolPendingBg`, `toolSuccessBg`,
  `toolErrorBg`, …
- Methods: `fg(slot, text)`, `bg(slot, text)`, `bold/italic/underline/inverse/strikethrough`,
  `getFgAnsi(slot)`, `getColorMode()` (`truecolor` | `256color`).

### 4.2 What you can do

- **Pick the slot per segment in your own components** — easy, this is what tool renderers already
  do (`theme.fg("accent", text)`). For a one-off color not covered by a slot, emit raw ANSI in your
  component (you own its bytes).
- **Switch / enumerate themes at runtime** via `ctx.ui`: `getAllThemes()`, `getTheme(name)`,
  `setTheme(name | ThemeObject)` → `{ success, error? }`, plus `ctx.ui.theme` (readonly current).
- **Install a fully custom theme**: `new Theme(fgColors, bgColors, mode, { name })` with your own
  hex/256 values for every slot, then `setTheme(themeInstance)`. Or ship theme **JSON files** and
  hand their paths back from the `resources_discover` event (`themePaths`) so they appear in the
  picker like built-ins.

### 4.3 What you cannot do

- **Add a new named color role.** The `ThemeColor`/`ThemeBg` unions are closed types. You reskin
  existing roles; you cannot introduce `myFeatureHighlight` as a first-class themed slot. Reuse the
  closest existing slot, or hardcode ANSI in your own component.
- **Recolor Pi's built-in chrome beyond what a theme covers.** If a piece of Pi UI doesn't read
  from a theme slot, a theme won't change it.

---

## 5. Interactive elements (panes, overlays, pickers)

Fully supported and the right tool for a "subagent-view", a task navigator, a chooser, etc. All
TUI-only — guard on `ctx.mode === "tui"`.

### 5.1 `ctx.ui.custom` — a focused component / overlay

```ts
const result = await ctx.ui.custom<TResult>(
  (tui, theme, keybindings, done) => new MyPane(tui, theme, keybindings, done),
  { overlay: true, overlayOptions: { /* position/size, static or () => opts */ }, onHandle }
);
```

- The factory returns a `Component` (optionally async) that **takes keyboard focus**. Call
  `done(result)` to close and resolve the promise. Optional `dispose()` for cleanup.
- `keybindings` is the app's `KeybindingsManager` — use it to match keys inside your component
  (see §7) so navigation stays consistent with the rest of the app.
- `overlay: true` floats it; `overlayOptions` (or a function for dynamic sizing) positions it;
  `onHandle(handle)` gives you an `OverlayHandle` to control visibility.

This is exactly how a subagent-view backed by `SubagentRegistry` / the progress condenser
(`src/runtime/subagent-registry.ts`, `subagent-progress.ts`) would be built. Effort is real — you
implement `render(width)`, input handling, focus, and `dispose` — but it is idiomatic and stable.

### 5.2 Persistent panes and chrome

- **`ctx.ui.setWidget(key, content, { placement })`** — a keyed pane rendered `"aboveEditor"` or
  `"belowEditor"`. `content` is either a `string[]` or a `(tui, theme) => Component` factory (with
  optional `dispose`). Pass `undefined` for that key to remove it. Good for a live status pane or a
  running-tasks strip that persists across turns.
- **`ctx.ui.setFooter(factory)` / `ctx.ui.setHeader(factory)`** — replace the built-in footer/header
  with your own component; `undefined` restores the default. The footer factory receives a
  `ReadonlyFooterDataProvider` (git branch, `setStatus` values). Token/model stats come from
  `ctx.sessionManager` / `ctx.model`, not the provider.
- **`ctx.ui.setStatus(key, text)`** — the lightweight option: set/clear a keyed status string in the
  footer without owning the whole footer. Prefer this over a custom footer for simple readouts.

---

## 6. Progress indicators

Several dedicated hooks — all low-risk:

- **`ctx.ui.setWorkingIndicator({ frames, intervalMs })`** — customize the streaming spinner.
  `frames: ["●"]` = static; `frames: []` = hidden; custom frames are rendered verbatim (add your
  own color). Omit the argument to restore the default animated spinner.
- **`ctx.ui.setWorkingMessage(msg)`** / **`ctx.ui.setWorkingVisible(bool)`** — the text and
  visibility of the "working" row shown during streaming.
- **`ctx.ui.setStatus(key, text)`** — footer status line (see §5.2).
- **Per-tool live progress** — the tool's `onUpdate` callback drives `renderResult(…, { isPartial:
  true })`. **PiCC already does this** for subagent tails and API-retry waits
  (`src/runtime/subagent-progress.ts` → `subagent-render.ts`). Copy that pattern for any long tool.
- **A persistent progress pane** — `setWidget` (§5.2).

---

## 7. Keybindings

### 7.1 The model

There is a real `KeybindingsManager` (`dist/core/keybindings.d.ts`) backed by a user
`keybindings.json`. Every action has a stable id and default keys, across three namespaces:

- `tui.editor.*` / `tui.input.*` / `tui.select.*` — text editing and list navigation,
- `app.*` — app actions: `app.interrupt` (Esc), `app.clear` (Ctrl-C), `app.exit` (Ctrl-D),
  `app.tools.expand` (Ctrl-O), `app.model.select` (Ctrl-L), `app.thinking.cycle` (Shift-Tab), …

Users override any of them in `keybindings.json`; the manager resolves user bindings over defaults
and reports conflicts.

### 7.2 What an extension can do

- **Add a new global shortcut** — `pi.registerShortcut(keyId, { description, handler })`. Easy; the
  handler gets a `ctx`. This is the supported way to add navigation/actions.
- **Own keys inside your own component/overlay** — you receive the `KeybindingsManager` in the
  `ctx.ui.custom` factory; call `keybindings.matches(data, "tui.select.down")` etc. so your pane's
  keys match the app's. Full control within that component.

### 7.3 What an extension cannot cleanly do

- **Rebind an existing Pi action from code.** There is no API to redefine what `app.interrupt` or
  `app.tools.expand` do. That is the user's `keybindings.json`. From code your only levers are:
  - **`ctx.ui.onTerminalInput(handler)`** — raw byte interception; return `{ consume: true }` to
    swallow a key or `{ data }` to rewrite it. **PiCC already uses this** to make forked skills
    Esc-cancellable (`src/index.ts` ~line 1262). Powerful but order-/precedence-sensitive and
    bypasses the keybinding abstraction — use sparingly and document it.
  - **`ctx.ui.setEditorComponent(factory)`** — replace the whole input editor by subclassing
    `CustomEditor` and overriding `handleInput` (call `super.handleInput` for keys you don't
    handle). This is the sanctioned "vim mode" path; heavy, and it makes you responsible for all the
    app keybindings the default editor forwards.

Treat true global rebinding as **out of scope** — it fights Pi's own model and the parity goal.

---

## 8. Other adaptable surfaces (for completeness)

- **Slash commands** — `pi.registerCommand(name, { description, handler, getArgumentCompletions })`.
  PiCC's `/doctor`, `/compat`, `/quota` live here (`src/index.ts`).
- **Custom transcript entries** — `pi.appendEntry(customType, data)` + `pi.registerEntryRenderer`
  (PiCC uses this for the compat notice; entries do **not** enter LLM context). For custom *messages*
  that do participate, `pi.sendMessage` + `pi.registerMessageRenderer`.
- **CLI flags** — `pi.registerFlag(name, { type, default })` + `pi.getFlag(name)`.
- **Terminal title** — `ctx.ui.setTitle(title)`.
- **Autocomplete** — `ctx.ui.addAutocompleteProvider(factory)` stacks on the built-in provider.
- **Tool expansion state** — `ctx.ui.getToolsExpanded()` / `setToolsExpanded(bool)`.
- **Notifications / dialogs** — `ctx.ui.notify(msg, "info"|"warning"|"error")`, and
  `ctx.ui.select/confirm/input/editor` for blocking prompts (respect `hasUI`).

---

## 9. What PiCC uses today (the starting point)

From `src/` (grep of `pi.*` / `ctx.ui.*`):

- Registration/events: `pi.on` (×15), `pi.registerTool`, `pi.registerCommand`,
  `pi.registerEntryRenderer` (×2), `pi.sendMessage`, `pi.appendEntry`, `pi.sendUserMessage`,
  `pi.setModel`, `pi.setThinkingLevel`, `pi.exec`.
- UI: `ctx.ui.notify` (×2), `ctx.ui.onTerminalInput` (Esc-cancel of forks).
- The mature rendering example: `src/runtime/subagent-render.ts` (+ `subagent-progress.ts`).

**Untapped but available right now:** `renderShell: "self"`, `pi.registerShortcut`,
`ctx.ui.custom`, `ctx.ui.setWidget`, `ctx.ui.setFooter`/`setHeader`, `ctx.ui.setStatus`,
`ctx.ui.setWorkingIndicator`/`setWorkingMessage`, full `ctx.ui.setTheme`,
`pi.registerMessageRenderer`, `ctx.ui.addAutocompleteProvider`, `ctx.ui.setTitle`,
`ctx.ui.setToolsExpanded`.

---

## 10. Hard boundaries — design around these

- **Global transcript layout, inter-block spacing, scrollback model** — render-loop internal, not
  exposed. No extension knob.
- **New named theme roles** — closed vocabulary (§4.3).
- **Global rebinding of Pi's built-in key actions from code** — user config only; extensions add or
  intercept, never reassign (§7.3).
- **Headless modes** — print/RPC/JSON have no interactive UI; every interactive feature needs a
  text-mode degrade.
- **Anything requiring changes to Pi itself** — possible only by patching/forking `pi-coding-agent`,
  which breaks the minimal-harness model and the "Claude Code projects run unchanged" goal, and is
  fragile across the pre-1.0 pin.

---

## 11. Checklist for a new UI feature

1. **Does it need interactivity?** If yes, guard `ctx.mode === "tui"` (or `ctx.hasUI`) and design
   the headless degrade first.
2. **Where does the `ctx` come from?** An event, a tool `execute`, or a command handler. Capture it
   there; don't assume ambient access.
3. **Rendering:** width-clamp with pi-tui's own measure, sanitize untrusted text before the clamp,
   null-guard the theme, never mutate `result.content`. (Copy `subagent-render.ts`.)
4. **Framing:** use `renderShell: "self"` only when you truly want to own every line; otherwise the
   default shell gives you gutter + diffs + truncation for free.
5. **Color:** prefer an existing `ThemeColor` slot over raw ANSI so themes keep working; there are
   no new slots.
6. **Keys:** add via `registerShortcut` or handle inside your own component; do not try to reassign
   Pi's actions.
7. **Upgrade safety:** if you touch `custom`/`widget`/`theme`/`setEditorComponent`, note it in
   [`doc/design/pi-integration.md`](pi-integration.md) §4 (churn watchpoints) and cover the import/
   shape in the Pi-contract smoke test — these are the newest, most-churning parts of the API.
8. **Parity check:** a Claude Code project does not expect PiCC-specific chrome. Make new UI additive
   and opt-in, not something that changes how an unmodified project renders.
