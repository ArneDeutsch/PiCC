import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  killProcessTreeByPidAndWait,
  processTreeSpawnEnv,
  windowsTaskkillPath,
  type AwaitedTreeKillIo,
} from "../src/util/process-tree.js";
import { mcpGitProbeEnv } from "../src/discovery/mcp.js";

const inherited = {
  PATH: "/bin",
  RETAINED: "yes",
  PICC_LAUNCHER_PID: "99",
  PICC_INSTALL_KIND: "source",
  PICC_VERSION: "1.2.3",
  PI_SKIP_VERSION_CHECK: "1",
};

function expectSanitized(env: NodeJS.ProcessEnv): void {
  expect(env.PATH).toBe("/bin");
  expect(env.RETAINED).toBe("yes");
  expect(env.PICC_LAUNCHER_PID).toBeUndefined();
  expect(env.PICC_INSTALL_KIND).toBeUndefined();
  expect(env.PICC_VERSION).toBeUndefined();
  expect(env.PI_SKIP_VERSION_CHECK).toBeUndefined();
}

describe("early helper subprocess environments", () => {
  it("sanitizes the MCP Git-tracked probe environment", () => {
    expectSanitized(mcpGitProbeEnv(inherited));
  });

  it("sanitizes process-tree ps/taskkill environments", () => {
    expectSanitized(processTreeSpawnEnv(inherited));
  });

  it("resolves taskkill through the trusted absolute System32 path", () => {
    expect(windowsTaskkillPath({ SystemRoot: "D:\\TrustedWindows" })).toBe(
      "D:\\TrustedWindows\\System32\\taskkill.exe",
    );
    expect(windowsTaskkillPath({ SystemRoot: "project-relative" })).toBe(
      "C:\\Windows\\System32\\taskkill.exe",
    );
  });
});

function fakeTaskkillIo(): {
  io: AwaitedTreeKillIo;
  child: EventEmitter & { kill: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> };
  commands: string[];
} {
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(() => true),
    unref: vi.fn(),
  });
  const commands: string[] = [];
  return {
    child,
    commands,
    io: {
      platform: "win32",
      taskkillPath: "C:\\Windows\\System32\\taskkill.exe",
      spawnTaskkill: (command) => {
        commands.push(command);
        return child as never;
      },
    },
  };
}

describe("awaited Windows process-tree cleanup", () => {
  it("stays pending until trusted taskkill reports successful completion", async () => {
    const fixture = fakeTaskkillIo();
    let settled = false;
    const completion = killProcessTreeByPidAndWait(42, 1_000, fixture.io).then((result) => {
      settled = true;
      return result;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(fixture.commands).toEqual(["C:\\Windows\\System32\\taskkill.exe"]);

    fixture.child.emit("close", 0);
    await expect(completion).resolves.toBe(true);
  });

  it.each([
    ["spawn error", (child: EventEmitter) => child.emit("error", new Error("denied"))],
    ["nonzero close", (child: EventEmitter) => child.emit("close", 1)],
  ])("keeps %s explicitly uncertain without destroying the root topology", async (_name, fail) => {
    const fixture = fakeTaskkillIo();
    const completion = killProcessTreeByPidAndWait(43, 1_000, fixture.io);
    fail(fixture.child);

    await expect(completion).resolves.toBe(false);
  });

  it("contains synchronous spawn failure as explicit uncertainty", async () => {
    const fixture = fakeTaskkillIo();
    fixture.io.spawnTaskkill = () => { throw new Error("spawn failed"); };

    await expect(killProcessTreeByPidAndWait(44, 1_000, fixture.io)).resolves.toBe(false);
  });

  it("bounds a hung taskkill and leaves cleanup explicitly uncertain", async () => {
    vi.useFakeTimers();
    try {
      const fixture = fakeTaskkillIo();
      const completion = killProcessTreeByPidAndWait(45, 50, fixture.io);
      await vi.advanceTimersByTimeAsync(50);

      await expect(completion).resolves.toBe(false);
      expect(fixture.child.kill).toHaveBeenCalledOnce();
      expect(fixture.child.unref).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
