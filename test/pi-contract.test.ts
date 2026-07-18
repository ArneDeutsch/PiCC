import { describe, expect, it } from "vitest";
import { fakePi } from "./helpers/fake-pi.js";

/**
 * Pi upstream contract smoke test: asserts every Pi API PiCC
 * builds on exists in the pinned version. If Pi churns, this fails first and loudly.
 */
describe("pi 0.80.x API contract", () => {
  it("exports the SDK surface PiCC uses", async () => {
    const sdk: Record<string, unknown> = await import("@earendil-works/pi-coding-agent");
    for (const name of [
      "createAgentSession",
      "DefaultResourceLoader",
      "SessionManager",
      "SettingsManager",
      "AuthStorage",
      "ModelRegistry",
      "defineTool",
      "createBashTool",
      "createReadTool",
      "createWriteTool",
      "createEditTool",
      "createGrepTool",
      "createFindTool",
      "createLsTool",
      "truncateHead",
      "truncateTail",
      "CONFIG_DIR_NAME",
    ]) {
      expect(sdk[name], `missing pi export: ${name}`).toBeDefined();
    }
  });

  it("SessionManager/SettingsManager expose in-memory factories", async () => {
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    expect(typeof sdk.SessionManager.inMemory).toBe("function");
    expect(typeof sdk.SettingsManager.inMemory).toBe("function");
  });

  it("SessionManager exposes create/open for persisted subagent transcripts", async () => {
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    expect(typeof sdk.SessionManager.create).toBe("function");
    expect(typeof sdk.SessionManager.open).toBe("function");
  });

  it("AgentSession exposes subscribe() for live progress", async () => {
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    // subscribe is an instance method; assert it's on the prototype (constructing
    // a real session needs a provider/model, out of scope for a contract smoke).
    expect(typeof sdk.AgentSession?.prototype?.subscribe).toBe("function");
  });

  it("AgentSession exposes steer()/followUp() for SendMessage steering", async () => {
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    expect(typeof sdk.AgentSession?.prototype?.steer).toBe("function");
    expect(typeof sdk.AgentSession?.prototype?.followUp).toBe("function");
  });

  it("AgentSession exposes getSessionStats() for usage accounting", async () => {
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    expect(typeof sdk.AgentSession?.prototype?.getSessionStats).toBe("function");
  });

  it("exposes create*ToolDefinition factories whose renderCall/renderResult are functions", async () => {
    // The self-shell de-padding of the built-ins sources renderers from these
    // public Definition factories (create*Tool strips renderers via
    // wrapToolDefinition). A Pi upgrade that moves/renames them — or drops the
    // renderer shape the wrap frames — fails loudly here rather than degrading
    // the built-in rows silently in the terminal.
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    for (const name of [
      "createReadToolDefinition",
      "createWriteToolDefinition",
      "createEditToolDefinition",
      "createBashToolDefinition",
      "createGrepToolDefinition",
      "createFindToolDefinition",
      "createLsToolDefinition",
    ]) {
      expect(typeof sdk[name], `missing/renamed ${name}`).toBe("function");
    }
    // read + edit are the payloads our renderers frame (truncation + diff) —
    // pin that both expose renderCall/renderResult on a constructed definition.
    for (const name of ["createReadToolDefinition", "createEditToolDefinition"]) {
      const def = sdk[name]("/cwd");
      expect(typeof def.renderCall, `${name}().renderCall`).toBe("function");
      expect(typeof def.renderResult, `${name}().renderResult`).toBe("function");
    }
  });

  it("our getTextOutput reproduction matches Pi's real render-utils.js transform", async () => {
    // We reproduce Pi's getTextOutput locally because the deep path is
    // exports-blocked by the package name. The concrete file IS importable via an
    // absolute file:// URL — pin the reproduction against Pi's own so a version
    // bump that changes the transform (CRLF stripping, image fallbacks) fails
    // loudly instead of silently diverging.
    const { getTextOutput: ours } = await import("../src/runtime/tool-shell.js");
    const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const distIdx = mainUrl.indexOf("/dist/");
    expect(distIdx, "unexpected Pi dist layout").toBeGreaterThan(0);
    const realUrl = `${mainUrl.slice(0, distIdx)}/dist/core/tools/render-utils.js`;
    const real: any = await import(realUrl);
    expect(typeof real.getTextOutput, "Pi render-utils getTextOutput moved").toBe("function");

    const payloads = [
      // CRLF-bearing text: every \r must be removed (a bare \r would return the
      // cursor to col 0 and corrupt the row).
      { content: [{ type: "text", text: "line-a\r\nline-b\rTAIL" }] },
      // Image block with no text: the [image …] fallback indicator is appended.
      { content: [{ type: "image", data: "Zm9v", mimeType: "image/png" }] },
      // Mixed text + image.
      {
        content: [
          { type: "text", text: "hello\r\nworld" },
          { type: "image", data: "Zm9v", mimeType: "image/png" },
        ],
      },
    ];
    for (const showImages of [false, true]) {
      for (const p of payloads) {
        expect(ours(p as never, showImages)).toBe(real.getTextOutput(p, showImages));
      }
    }
  });

  it("extension ctx pins the UI widget surface and the mode/hasUI gating reality", async () => {
    // The subagent status panel installs via ctx.ui.setWidget from a
    // `ctx.mode === "tui"` gate. This pins WHY that gate (and only that gate)
    // is valid, against Pi's real ExtensionRunner ctx:
    //  - Default (print) mode: hasUI is FALSE, but every UI verb — setWidget,
    //    custom, onTerminalInput — is PRESENT as a no-op (Pi's noOpUIContext
    //    implements the full ExtensionUIContext). Method presence therefore
    //    proves nothing about interactivity.
    //  - A bound non-TUI UI context (RPC): hasUI flips TRUE while mode stays
    //    "rpc" — so a hasUI gate would wrongly install TUI chrome in RPC.
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    const runner = new sdk.ExtensionRunner(
      [],
      sdk.createExtensionRuntime(),
      process.cwd(),
      {},
      {},
    );
    const ctx = runner.createContext();
    expect(ctx.mode).toBe("print");
    expect(ctx.hasUI).toBe(false);
    for (const verb of ["setWidget", "custom", "onTerminalInput", "notify", "setStatus"]) {
      expect(typeof ctx.ui[verb], `print-mode ui.${verb} must exist (no-op)`).toBe("function");
    }
    // No-op reality: callable without a TUI, returning nothing/unsubscribe.
    expect(ctx.ui.setWidget("k", ["x"], { placement: "belowEditor" })).toBeUndefined();
    expect(typeof ctx.ui.onTerminalInput(() => undefined)).toBe("function");
    await expect(ctx.ui.custom(() => ({ render: () => [] }))).resolves.toBeUndefined();

    // Bind a (dummy) UI context as RPC mode does → the hasUI trap.
    runner.setUIContext({ setWidget: () => undefined }, "rpc");
    expect(ctx.mode).toBe("rpc");
    expect(ctx.hasUI).toBe(true);
  });

  it("fake-pi's print-mode ctx matches the pinned print-mode reality", async () => {
    // The "no setWidget in print mode" tests must model Pi, not mirror
    // whichever field the implementation happens to read — so the fake's
    // print ctx is pinned here against the same shape as the real one above.
    const ctx: any = fakePi().printCtx();
    expect(ctx.mode).toBe("print");
    expect(ctx.hasUI).toBe(false);
    for (const verb of ["setWidget", "custom", "onTerminalInput", "notify", "setStatus"]) {
      expect(typeof ctx.ui[verb], `fake print-mode ui.${verb} must exist`).toBe("function");
    }
  });

  it("registerShortcut exists on the extension API and records the shortcut", async () => {
    // The panel-entry chord (alt+a) registers through pi.registerShortcut;
    // fake-pi mirrors it, so a Pi rename must fail here first. The loader is
    // not re-exported at the package root, so it is imported by file URL —
    // the same pattern as the render-utils getTextOutput pin above.
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const distIdx = mainUrl.indexOf("/dist/");
    expect(distIdx, "unexpected Pi dist layout").toBeGreaterThan(0);
    const loader: any = await import(`${mainUrl.slice(0, distIdx)}/dist/core/extensions/loader.js`);
    expect(typeof loader.loadExtensionFromFactory, "Pi extension loader moved").toBe("function");
    let captured: any;
    const ext = await loader.loadExtensionFromFactory(
      (pi: any) => {
        captured = pi;
        pi.registerShortcut("alt+a", { description: "probe", handler: () => undefined });
      },
      process.cwd(),
      sdk.createEventBus(),
      sdk.createExtensionRuntime(),
    );
    expect(typeof captured.registerShortcut).toBe("function");
    expect(ext.shortcuts.get("alt+a")?.description).toBe("probe");
  });

  it("registerMessageRenderer exists on the real ExtensionAPI and sendMessage threads a details param", async () => {
    // The picc-settlement completion record hangs off BOTH seams: index.ts
    // registers a custom-message renderer via pi.registerMessageRenderer and
    // attaches the structured record payload as sendMessage's `details`. A Pi
    // rename/drop must fail here first, not degrade the settlement notice
    // silently to the default box (or strip the record data).
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    const mainUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const distIdx = mainUrl.indexOf("/dist/");
    expect(distIdx, "unexpected Pi dist layout").toBeGreaterThan(0);
    const loader: any = await import(`${mainUrl.slice(0, distIdx)}/dist/core/extensions/loader.js`);
    const runtime = loader.createExtensionRuntime
      ? loader.createExtensionRuntime()
      : sdk.createExtensionRuntime();
    let captured: any;
    const renderer = () => undefined;
    const ext = await loader.loadExtensionFromFactory(
      (pi: any) => {
        captured = pi;
        pi.registerMessageRenderer("picc-contract-probe", renderer);
      },
      process.cwd(),
      sdk.createEventBus(),
      runtime,
    );
    expect(typeof captured.registerMessageRenderer, "Pi moved: ExtensionAPI.registerMessageRenderer").toBe(
      "function",
    );
    // Registration is recorded where the interactive mode reads it back.
    expect(
      ext.messageRenderers?.get("picc-contract-probe"),
      "Pi moved: registerMessageRenderer no longer records into Extension.messageRenderers",
    ).toBe(renderer);
    // sendMessage accepts and threads `details` (bind the runtime slot the way
    // Runner.bindCore does — createExtensionRuntime ships throwing stubs).
    const sent: Array<{ message: any; options: any }> = [];
    runtime.sendMessage = (message: any, options: any) => sent.push({ message, options });
    captured.sendMessage(
      { customType: "picc-contract-probe", content: "c", display: true, details: { probe: 1 } },
      { deliverAs: "steer" },
    );
    expect(sent, "Pi moved: ExtensionAPI.sendMessage no longer forwards to the runtime").toHaveLength(1);
    expect(
      sent[0]!.message.details,
      "Pi moved: sendMessage dropped/renamed the details param",
    ).toEqual({ probe: 1 });
    expect(sent[0]!.options?.deliverAs).toBe("steer");
  });

  it("CustomMessageComponent drives the registered renderer with a BOOLEAN expanded and defaults on undefined", async () => {
    // The collapsed-by-default settlement record keys on the EXPLICIT
    // `options.expanded === false`; nested/detail-less messages return undefined
    // to get Pi's default box. Pin both against Pi's REAL interactive component
    // (exported at the package root), so a Pi change to the renderer calling
    // convention fails loudly here.
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    // The component reads Pi's module-global theme singleton — initialize it,
    // as the wired-edit integration test does.
    sdk.initTheme();
    const message = {
      role: "custom",
      customType: "picc-probe",
      content: "notice body",
      display: true,
      details: { record: "probe" },
      timestamp: Date.now(),
    };
    const seen: unknown[] = [];
    const component = new sdk.CustomMessageComponent(message, (m: any, options: any) => {
      expect(m, "Pi moved: renderer no longer receives the CustomMessage itself").toBe(message);
      seen.push(options?.expanded);
      return { render: () => ["probe-line"] };
    });
    // The global Ctrl+O toggle reaches custom messages through setExpanded.
    expect(
      typeof component.setExpanded,
      "Pi moved: CustomMessageComponent.setExpanded (Ctrl+O expand reach)",
    ).toBe("function");
    component.setExpanded(true);
    expect(seen, "Pi moved: message renderer no longer gets a boolean `expanded`").toEqual([
      false,
      true,
    ]);
    expect(component.render(80).join("\n")).toContain("probe-line");
    // A renderer returning undefined falls back to Pi's default labeled box.
    const fallback = new sdk.CustomMessageComponent(message, () => undefined);
    expect(fallback.render(80).join("\n")).toContain("picc-probe");
  });

  it("typebox + StringEnum are importable the way our tools use them", async () => {
    const { Type } = await import("typebox");
    const { StringEnum } = await import("@earendil-works/pi-ai");
    expect(typeof Type.Object).toBe("function");
    expect(typeof StringEnum).toBe("function");
  });

  it("type pins compile against the pinned Pi: stopReason/errorMessage, 5-arg execute, transcript surface, subscribe + event kinds", async () => {
    // vitest strips types without checking them and the project tsconfig
    // excludes test/, so the pins live in test/helpers/pi-contract-pins.ts and
    // are compiled HERE with the real TypeScript checker — Pi type churn fails
    // this test with the actual tsc diagnostics.
    const { createRequire } = await import("node:module");
    const { execFileSync } = await import("node:child_process");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const require = createRequire(import.meta.url);
    const tscBin = path.join(path.dirname(require.resolve("typescript/package.json")), "bin", "tsc");
    const pinsConfig = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "helpers",
      "pi-contract-pins.tsconfig.json",
    );
    let output = "";
    let failed = false;
    try {
      output = execFileSync(process.execPath, [tscBin, "-p", pinsConfig], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      failed = true;
      const e = err as { stdout?: string; stderr?: string; message: string };
      output = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message}`;
    }
    expect(failed, `Pi type contract broken:\n${output}`).toBe(false);
  }, 30_000);
});

/**
 * Pin Pi's `ctx.lastComponent` threading with a contract
 * test that drives the REAL, publicly-exported `ToolExecutionComponent`.
 *
 * The de-padded built-ins depend on Pi caching the component our wrapper returns
 * and handing it back as `ctx.lastComponent` on the next render (the `__inner`
 * threading exists precisely to survive this; `edit`'s `instanceof Box`
 * incremental reuse breaks if the wrong component is threaded). PiCC's OWN
 * threading is unit-tested against a fake ctx (`test/runtime-core.test.ts`); this
 * asserts PI's side of the contract, so a Pi upgrade that stops threading the
 * prior component fails loudly here instead of degrading incremental rendering
 * silently in the terminal.
 */
describe("ToolExecutionComponent threads the prior render component as ctx.lastComponent", () => {
  it("hands back the previously-returned component (undefined on the first render), for renderCall and renderResult", async () => {
    const { ToolExecutionComponent, initTheme } = (await import(
      "@earendil-works/pi-coding-agent"
    )) as any;
    // The render loop reads a module-global `theme`; initialize it first so
    // render()/updateDisplay() don't throw — same pattern as the wired-edit
    // integration test (test/integration-extension.test.ts).
    initTheme();

    // For each renderer slot: the lastComponent it was HANDED on each invocation,
    // and the fresh sentinel it RETURNED (so we can assert identity, not truthiness).
    const call: { seen: unknown[]; returned: unknown[] } = { seen: [], returned: [] };
    const result: { seen: unknown[]; returned: unknown[] } = { seen: [], returned: [] };

    // A sentinel Component: a plain `{ render() }` is a valid pi-tui child
    // (Container.addChild just stores it; render() collects child.render(width)).
    const sentinel = () => ({ render: () => [] as string[] });

    // Instrumented tool definition. renderShell:"self" mirrors PiCC's real usage
    // (the built-ins register self-shell), though Pi's caching is shell-independent.
    const toolDefinition = {
      name: "PiccLastComponentProbe",
      renderShell: "self",
      renderCall: (_args: unknown, _theme: unknown, ctx: { lastComponent: unknown }) => {
        call.seen.push(ctx.lastComponent);
        const c = sentinel();
        call.returned.push(c);
        return c;
      },
      renderResult: (
        _res: unknown,
        _opts: unknown,
        _theme: unknown,
        ctx: { lastComponent: unknown },
      ) => {
        result.seen.push(ctx.lastComponent);
        const c = sentinel();
        result.returned.push(c);
        return c;
      },
    };

    // A made-up toolName so `builtInToolDefinition` (createAllToolDefinitions(cwd)
    // [toolName]) is undefined and ONLY the instrumented definition drives rendering.
    const component = new ToolExecutionComponent(
      "PiccLastComponentProbe",
      "picc-tc-1",
      { probe: "args-1" },
      {},
      toolDefinition,
      { requestRender() {} },
      process.cwd().replace(/\\/g, "/"),
    );

    // The constructor already ran one updateDisplay (renderCall #1; no result yet).
    // Drive a second call render, then two result renders — each updateDisplay pass
    // re-invokes the renderers and threads the prior returned component back.
    const mkResult = (text: string) => ({
      content: [{ type: "text", text }],
      details: {},
      isError: false,
    });
    component.updateArgs({ probe: "args-2" }); // renderCall #2
    component.updateResult(mkResult("out-1"), false); // renderResult #1 (+ renderCall #3)
    component.updateResult(mkResult("out-2"), false); // renderResult #2 (+ renderCall #4)
    component.render(80); // exercise the self-shell render path with the sentinels

    // renderCall: 1st render sees `undefined`; the 2nd sees EXACTLY the component
    // the renderer returned on the 1st render — non-vacuous (identity, not truthy).
    expect(call.seen.length).toBeGreaterThanOrEqual(2);
    expect(call.seen[0]).toBeUndefined();
    expect(call.seen[1]).toBe(call.returned[0]);

    // renderResult is cached in a SEPARATE slot — same contract holds independently.
    expect(result.seen.length).toBeGreaterThanOrEqual(2);
    expect(result.seen[0]).toBeUndefined();
    expect(result.seen[1]).toBe(result.returned[0]);

    // The two slots really are independent caches (call sentinel is never handed
    // to the result renderer and vice-versa).
    expect(call.returned[0]).not.toBe(result.returned[0]);
    expect(result.seen[1]).not.toBe(call.returned[0]);
  });
});
