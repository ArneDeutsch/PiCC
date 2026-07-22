# PiCC TUI extension guide

A reference for anyone adding or changing **terminal-UI behavior** in PiCC — custom tool
rendering, colors/themes, interactive panes, progress indicators, and keybindings. It records
what Pi's extension API makes possible, how hard each thing is, and what to avoid, so we don't
have to re-derive it from `node_modules` every time.

For the broader integration contracts see [`doc/pi-integration.md`](pi-integration.md);
for the module map see [`doc/architecture.md`](architecture.md). This guide is the TUI-specific
companion to both.

> **Baseline:** the declared and tested Pi `@earendil-works/pi-*` 0.80.10 suite
> (`package.json` uses `^0.80.10`; the lockfile resolves 0.80.10 exactly). The public extension,
> renderer, mode, widget/input, shortcut/message-renderer, and theme declarations below were
> re-verified against `pi-coding-agent` 0.80.10. Their authoritative declarations are
> `dist/core/extensions/types.d.ts` and `dist/modes/interactive/theme/theme.d.ts`; re-verify them
> on every Pi upgrade because this is a pre-1.0 surface.

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
| Remove vertical padding / blank rows around a tool row | **Done (generic wrapper, plus Edit inner adapter) · Impossible (inter-block)** | `renderShell: "self"` + per-line `theme.bg` re-apply in `wrapForSelfShell`; the one-column horizontal gutter remains; Edit's renderer adds nested padding removed by `withRoutineToolRendering`, then safely recognized settled rows pass through `withDefaultCollapsedToolRendering`; inter-block spacing is render-loop-internal |
| Colors in our own components | **Easy** | `theme.fg("<slot>", text)`, `theme.bg`, `theme.bold/italic/...`, or raw ANSI |
| Re-skin the whole UI / switch themes | **Medium** | `ctx.ui.setTheme`, `new Theme(...)`, ship theme JSON via `resources_discover` |
| Add a **new named color role** | **Impossible** | `ThemeColor` union is closed |
| New interactive pane (subagent-view, picker, navigator) | **Done** (subagent panel + drill-down — `src/runtime/subagent-panel-focus.ts`) | `ctx.ui.custom(factory, { overlay, overlayOptions, onHandle })` |
| Persistent pane above/below the editor | **Done** (subagent status panel — `src/runtime/subagent-panel-widget.ts`) | `ctx.ui.setWidget(key, content \| factory, { placement })` |
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

The `ToolDefinition` type (in `types.d.ts`) may supply:

```ts
renderCall?:   (args, theme, ctx) => Component
renderResult?: (result, options, theme, ctx) => Component
renderShell?:  "default" | "self"
```

A **Component** is the structural pi-tui contract: `{ render(width: number): string[] }`. PiCC's
renderers use the untyped structural form, so no pi-tui type import is needed — but the `theme`
argument **is** Pi's `Theme` (see "Colors and themes").

- `options` for `renderResult` is `{ expanded: boolean; isPartial: boolean }`. `isPartial` is the
  streaming case (a live, not-yet-final result); render the rolling/partial view then.
- `ctx` is a `ToolRenderContext` (args, `toolCallId`, `invalidate()`, `expanded`, `isError`,
  `cwd`, …) — use `invalidate()` to force a redraw of just that row.

### 3.2 `renderShell` — this is how you control blank lines and framing

`ToolExecutionComponent` (in `dist/modes/interactive/components/tool-execution.js`) wraps a tool
row in a standard **colored shell** — a `Box(paddingX=1, paddingY=1, bgFn)` giving the 1-column
gutter (`paddingX`) and the colored blank line above **and** below the content (`paddingY`) you see
around every tool row. `renderShell: "self"` swaps that `Box` for a bare `selfRenderContainer` and
hands *all* framing to your component — you emit exactly the lines you want, no more, no less. The
catch: self mode **drops Pi's colored `Box` entirely** — plain container, exactly one plain `""`
inter-block separator prepended, **no background**. So `renderShell: "self"` is the only lever that
removes the padding, but any row that takes it must re-apply the state background itself.

PiCC uses this today to de-pad **every** tool row (all Claude-named tools *and* the re-registered
built-ins). A generic **self-shell wrapper** (`wrapForSelfShell` in `src/runtime/tool-shell.ts`) is
applied at both tool-registration seams. Lowercase Edit is the exception inside that generic frame:
Pi's call renderer returns its own padded `Box`, so `withRoutineToolRendering` first removes only
that Box's verified outer padding pair while retaining its interior spacer and state. The
`withDefaultCollapsedToolRendering` adapter compacts only recognized settled interactive
successes. The configured `app.tools.expand` action restores native call/result detail. Live,
exceptional, unfamiliar, and unbound-action rows remain elaborated; malformed display fields fall
back to a concise warning. For any tool
the generic wrapper sets `renderShell: "self"`, strips the leading/trailing blank lines, keeps the
1-column gutter, and **re-applies `theme.bg` per line** — self-render drops the tint deliberately, so PiCC
frames the row with a real pi-tui `Box(paddingY=0)` (content clamped to `width - 2*gutter`, then
gutter + width-fill, painted via the theme's own `bg`) — byte-exact with Pi's default row, minus the
padding, and inheriting Box's render cache. Read `tool-shell.ts` before touching this:
the framing step order (strip/clamp before the Box paints) and the throw-guards on `theme.bg` are load-bearing — self-render is *not*
wrapped in Pi's try/catch, so an unguarded throw (unknown bg slot, absent theme, a negative
`repeat`) kills Pi's whole render loop; a headless / no-theme render degrades to plain text.

- **Own tools with a renderer:** the wrapper invokes the tool's own `renderCall`/`renderResult`,
  including renderers added by a registration-time decorator, then frames the result via the Box.
- **Own tools without a renderer:** the wrapper injects a **generic fallback** reproducing Pi's own
  `createCallFallback` (bold tool title) and `createResultFallback` (`getTextOutput` result text),
  so a renderer-less tool de-pads without anyone writing a bespoke renderer.
- **Built-ins** (`bash`/`read`/`write`/`edit`/`grep`/`find`/`ls`): **wrapped, not reimplemented.** PiCC
  re-registers these for cwd-swap (`src/index.ts`, the "Cwd-swapping overrides" block). Their
  renderers are sourced from the public `create*ToolDefinition` factories — the plain `create*Tool`
  factory strips `renderCall`/`renderResult` via `wrapToolDefinition` — while **`execute` stays
  sourced from the plain factory unchanged**. Edit's narrow call adapter preserves the inner Box in
  `ctx.lastComponent`; MultiEdit delegates a detached successful diff snapshot to the public Edit
  result renderer instead of implementing another diff path. The settled-collapse adapter composes
  those native renderers rather than replacing them and is installed only on main-session
  definitions; subagent built-ins remain raw. Execution remains byte-identical (live-cwd
  re-resolution, bash spawnHook/env, and `read`'s `ctx?.model` non-vision note all preserved).
- **`ctx.lastComponent` threading is the load-bearing coupling.** `ToolExecutionComponent` caches
  the component we return and hands it back as `ctx.lastComponent` on the next render; the built-ins
  reuse it for incremental state (`read`/`bash` via `?? new …`, `edit` via an `instanceof Box`
  reuse). A naive wrap would hand the inner renderer *our* wrapper and silently lose that state
  (`edit` especially), so the wrapper stashes the inner component (`__inner`) and threads the
  *previous inner* component back. This couples to Pi's render contract, and the coupling is
  **pinned**: a contract test drives the real `ToolExecutionComponent` and asserts Pi hands the
  previously-returned component back as `ctx.lastComponent` on the next render (undefined on the
  first), for both the `renderCall` and `renderResult` slots (`test/pi-contract.test.ts`). PiCC's
  own threading is unit-tested and Pi's side is asserted, so a Pi change here fails loudly in CI
  rather than degrading incremental rendering silently (see "Risks / churn watchpoints" in
  [`pi-integration.md`](pi-integration.md)).
- **The blank line Pi inserts *between* transcript blocks is still not yours.** That is render-loop
  layout (self mode prepends exactly one), not a tool concern. No extension knob changes it — it is
  the hard boundary that still separates two adjacent de-padded rows. Plan around it.

### 3.3 Rules to copy from `subagent-render.ts`

These are not style preferences — violating them crashes the app or leaks terminal control:

1. **Width is a hard contract.** pi-tui throws an `uncaughtException` (kills the process) if any
   rendered line's *visible* width exceeds `width`. Measure with pi-tui's own
   `visibleWidth`/`truncateToWidth`/`wrapTextWithAnsi` (grapheme + East-Asian-width + tabs=3), not
   `String.length`. Always run a final clamp pass over every line you return (`clampLines`).
2. **Sanitize model-/file-supplied text — at capture first, at render as a backstop.** Tool args,
   subagent output, file contents can carry ANSI/OSC/control sequences. The primary pass is
   **capture-time**: the subagent registry and progress condenser sanitize strings as they are
   stored (`sanitizeProgressText` / `sanitizeLine` in `src/runtime/subagent-progress.ts`), so no
   downstream surface holds hostile bytes. Renderers keep a second pass as defense in depth — and
   it is mandatory for anything deliberately stored raw (`agentName`, the registry's name-index
   key, is sanitized only at render). Either pass runs *before* the width clamp (the clamp
   preserves ANSI verbatim — it is a width tool, not a sanitizer). This is **security, not
   cosmetics**: unsanitized text lets a hostile file inject escape sequences into the parent
   terminal.
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

- `ThemeColor` (~45 slots): `accent`, `border`, `success`, `error`, `warning`, `muted`, `dim`,
  `text`, `toolTitle`, `toolOutput`, `mdHeading`, `mdCode`, `mdCodeBlock`, `toolDiffAdded`,
  `toolDiffRemoved`, `syntaxKeyword`/`syntaxString`/… , `thinkingOff`…`thinkingMax`, `bashMode`, …
- `ThemeBg` (6 slots, all of them): `selectedBg`, `userMessageBg`, `customMessageBg`,
  `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`.
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
  (see "Keybindings") so navigation stays consistent with the rest of the app.
- `overlay: true` floats it; `overlayOptions` (or a function for dynamic sizing) positions it;
  `onHandle(handle)` gives you an `OverlayHandle` to control visibility.

This is how the subagent panel + drill-down (`src/runtime/subagent-panel-focus.ts`, backed by
`SubagentRegistry` / the progress condenser) is built — read it before writing a new focused
component. Effort is real — you implement `render(width)`, input handling, focus, and `dispose` —
but it is idiomatic and stable. Two substrate facts it encodes: Pi swaps the editor out (saving
its draft) and restores it on close, so focus/draft handling is free; and a `registerShortcut`
chord dispatches only while the default editor is focused, while raw `onTerminalInput` listeners
run *before* the focused component — so a raw listener must yield to an open component itself.

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
- **`ctx.ui.setStatus(key, text)`** — footer status line (see "Persistent panes and chrome").
- **Per-tool live progress** — the tool's `onUpdate` callback drives `renderResult(…, { isPartial:
  true })`. **PiCC already does this** for subagent lifecycle status and API-retry waits
  (`src/runtime/subagent-progress.ts` → `subagent-render.ts`); bounded structured live detail lives
  in the selected-agent view, not list or tool rows. Copy the pattern for any long tool.
- **A persistent progress pane** — `setWidget` (see "Persistent panes and chrome"); the subagent
  status panel (`src/runtime/subagent-panel-widget.ts`) is the shipped example, including the
  interval-owned-by-the-component lifecycle.

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
    Esc-cancellable (the `pi.on("input", …)` handler in `src/index.ts`). Powerful but
    order-/precedence-sensitive and bypasses the keybinding abstraction — use sparingly and
    document it.
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

- Registration/events: `pi.on`, `pi.registerTool`, `pi.registerCommand`,
  `pi.registerEntryRenderer`, `pi.registerMessageRenderer` (subagent settlement records),
  `pi.registerShortcut` (the panel entry chord), `pi.sendMessage`, `pi.appendEntry`,
  `pi.sendUserMessage`, `pi.setModel`, `pi.setThinkingLevel`, `pi.exec`.
- UI: `ctx.ui.notify`, `ctx.ui.setWidget` (the passive subagent status panel), `ctx.ui.custom`
  (the focused panel list + drill-down), `ctx.ui.onTerminalInput` (Esc-cancel of forks — the
  watcher yields a lone Esc to the open panel, since raw listeners run before the focused
  component).
- The mature rendering examples: `src/runtime/subagent-render.ts` (+ `subagent-progress.ts`) for
  tool rows, `src/runtime/subagent-panel-render.ts` (+ `subagent-panel-model.ts`,
  `render-util.ts`) for a pure widget/component view.
- Tool-row framing: specialized/routine adapters → `withDefaultCollapsedToolRendering` →
  `wrapForSelfShell` (`src/runtime/tool-shell.ts`). This de-pads every main-session row while compacting
  only safely recognized settled successes; expansion restores native detail. Live, exceptional,
  unfamiliar, and unbound rows remain elaborated; malformed display fields fall back to a concise
  warning (see "`renderShell` — this is how you control blank lines and framing").

**Untapped but available right now:** `ctx.ui.setFooter`/`setHeader`, `ctx.ui.setStatus`,
`ctx.ui.setWorkingIndicator`/`setWorkingMessage`, full `ctx.ui.setTheme`,
`ctx.ui.addAutocompleteProvider`, `ctx.ui.setTitle`, `ctx.ui.setToolsExpanded`.

---

## 10. Hard boundaries — design around these

- **Global transcript layout, inter-block spacing, scrollback model** — render-loop internal, not
  exposed. No extension knob.
- **New named theme roles** — closed vocabulary (see "What you cannot do" under "Colors and
  themes").
- **Global rebinding of Pi's built-in key actions from code** — user config only; extensions add or
  intercept, never reassign (see "What an extension cannot cleanly do").
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
7. **Upgrade safety:** if you touch `custom`/`widget`/`theme`/`setEditorComponent`, note it under
   "Risks / churn watchpoints" in [`doc/pi-integration.md`](pi-integration.md) and cover the
   import/shape in the Pi-contract smoke test — these are the newest, most-churning parts of the
   API.
8. **Parity check:** a Claude Code project does not expect PiCC-specific persistent or interactive
   chrome. Make that UI additive and opt-in. Default tool-presentation adapters may apply
   automatically when they change only human rendering, preserve canonical results, and keep
   failures and unfamiliar outcomes visible.
