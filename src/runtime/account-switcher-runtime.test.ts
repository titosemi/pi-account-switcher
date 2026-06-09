import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { describe, expect, it, beforeAll } from "vitest";
import AccountSwitcherRuntime from "./account-switcher-runtime";
import { useAccountService } from "../services";
import type { AccountSwitcherContext } from "../types";

/** Build a minimal mock of AccountSwitcherContext for testing init(). */
function mockCtx(overrides: {
  cwd?: string;
  sessionFile?: string;
}): AccountSwitcherContext {
  const authStorage = { set: () => {}, reload: () => {}, removeRuntimeApiKey: () => {}, get: () => undefined };
  return {
    cwd: overrides.cwd ?? homedir(),
    hasUI: false,
    ui: {
      notify: () => {},
      setStatus: () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      onTerminalInput: () => () => {},
    } as any,
    modelRegistry: { authStorage, find: () => undefined } as any,
    model: undefined,
    sessionManager:
      overrides.sessionFile !== undefined
        ? ({ getSessionFile: () => overrides.sessionFile } as any)
        : undefined,
  } as any;
}

describe("AccountSwitcherRuntime", () => {
  describe("init cascade", () => {
    it("uses session state when it exists (beats dir matching)", async () => {
      const dir = await mkdtemp(join(tmpdir(), "runtime-cascade-"));
      const accPath = join(dir, "accounts.json");
      const provPath = join(dir, "providers.json");
      const statePath = join(dir, "state.json");

      // Set up accounts: "personal" has a dir that matches cwd, "pxs" is defaultAccountId
      const setup = useAccountService(accPath, statePath);
      await setup.addAccount({
        id: "personal",
        label: "Personal",
        provider: "opencode",
        dirs: ["/home/user/my-project"],
        piAuth: { provider: "opencode", entry: { type: "api_key", key: "sk-test" } },
      });
      await setup.addAccount({
        id: "pxs",
        label: "PXS",
        provider: "opencode",
        dirs: ["/home/user/work-project"],
        piAuth: { provider: "opencode", entry: { type: "api_key", key: "sk-test" } },
      });
      await setup.setDefaultAccountId("pxs");

      // Pre-populate session state for the session key derived from "session-mysession"
      const { createHash } = await import("node:crypto");
      const sessionKey = createHash("sha256").update("session-mysession").digest("hex").slice(0, 12);
      const { useStateStore } = await import("../storage");
      await useStateStore(statePath).saveSession(sessionKey, { activeAccountId: "pxs" });

      // Create runtime with custom paths and run init in a dir that would match "personal"
      const pi = { registerProvider: () => {}, setModel: () => {} };
      const runtime = new AccountSwitcherRuntime(pi, { accounts: accPath, providers: provPath, state: statePath });
      const ctx = mockCtx({ cwd: "/home/user/my-project", sessionFile: "session-mysession" });
      await runtime.init(ctx);

      // Session state has "pxs" — should win over dirs match to "personal"
      expect(runtime.getActiveAccount()?.id).toBe("pxs");
    });

    it("uses dir-matched account when no session state (dirs beat defaultAccountId)", async () => {
      const dir = await mkdtemp(join(tmpdir(), "runtime-cascade-"));
      const accPath = join(dir, "accounts.json");
      const provPath = join(dir, "providers.json");
      const statePath = join(dir, "state.json");

      const setup = useAccountService(accPath, statePath);
      await setup.addAccount({
        id: "personal",
        label: "Personal",
        provider: "opencode",
        dirs: ["/home/user/my-project"],
        piAuth: { provider: "opencode", entry: { type: "api_key", key: "sk-test" } },
      });
      await setup.addAccount({
        id: "pxs",
        label: "PXS",
        provider: "opencode",
        piAuth: { provider: "opencode", entry: { type: "api_key", key: "sk-test" } },
      });
      await setup.setDefaultAccountId("pxs");

      const pi = { registerProvider: () => {}, setModel: () => {} };
      const runtime = new AccountSwitcherRuntime(pi, { accounts: accPath, providers: provPath, state: statePath });
      const ctx = mockCtx({ cwd: "/home/user/my-project" });
      await runtime.init(ctx);

      // No session state, but cwd matches "personal" dirs — should pick personal
      expect(runtime.getActiveAccount()?.id).toBe("personal");
    });

    it("falls back to defaultAccountId when no session state and no dir match", async () => {
      const dir = await mkdtemp(join(tmpdir(), "runtime-cascade-"));
      const accPath = join(dir, "accounts.json");
      const provPath = join(dir, "providers.json");
      const statePath = join(dir, "state.json");

      const setup = useAccountService(accPath, statePath);
      await setup.addAccount({
        id: "personal",
        label: "Personal",
        provider: "opencode",
        dirs: ["/home/user/my-project"],
        piAuth: { provider: "opencode", entry: { type: "api_key", key: "sk-test" } },
      });
      await setup.addAccount({
        id: "pxs",
        label: "PXS",
        provider: "opencode",
        piAuth: { provider: "opencode", entry: { type: "api_key", key: "sk-test" } },
      });
      await setup.setDefaultAccountId("pxs");

      const pi = { registerProvider: () => {}, setModel: () => {} };
      const runtime = new AccountSwitcherRuntime(pi, { accounts: accPath, providers: provPath, state: statePath });
      const ctx = mockCtx({ cwd: "/some/unrelated/path" });
      await runtime.init(ctx);

      // No session, no dir match → defaultAccountId "pxs"
      expect(runtime.getActiveAccount()?.id).toBe("pxs");
    });

    it("leaves no active account when cascade exhausts all options", async () => {
      const dir = await mkdtemp(join(tmpdir(), "runtime-cascade-"));
      const accPath = join(dir, "accounts.json");
      const provPath = join(dir, "providers.json");
      const statePath = join(dir, "state.json");

      // Accounts but no defaultAccountId and no dirs match
      const setup = useAccountService(accPath, statePath);
      await setup.addAccount({
        id: "work",
        label: "Work",
        provider: "opencode",
        dirs: ["/home/user/work"],
        piAuth: { provider: "opencode", entry: { type: "api_key", key: "sk-test" } },
      });

      const pi = { registerProvider: () => {}, setModel: () => {} };
      const runtime = new AccountSwitcherRuntime(pi, { accounts: accPath, providers: provPath, state: statePath });
      const ctx = mockCtx({ cwd: "/somewhere/else" });
      await runtime.init(ctx);

      expect(runtime.getActiveAccount()).toBeUndefined();
    });

    it("persists session state after init so subsequent init uses it directly", async () => {
      const dir = await mkdtemp(join(tmpdir(), "runtime-cascade-"));
      const accPath = join(dir, "accounts.json");
      const provPath = join(dir, "providers.json");
      const statePath = join(dir, "state.json");

      const setup = useAccountService(accPath, statePath);
      await setup.addAccount({
        id: "personal",
        label: "Personal",
        provider: "opencode",
        dirs: ["/home/user/my-project"],
        piAuth: { provider: "opencode", entry: { type: "api_key", key: "sk-test" } },
      });
      await setup.addAccount({
        id: "pxs",
        label: "PXS",
        provider: "opencode",
        piAuth: { provider: "opencode", entry: { type: "api_key", key: "sk-test" } },
      });
      await setup.setDefaultAccountId("pxs");

      const pi = { registerProvider: () => {}, setModel: () => {} };
      const runtime = new AccountSwitcherRuntime(pi, { accounts: accPath, providers: provPath, state: statePath });

      // First init: no session state → dirs match "personal"
      const ctx1 = mockCtx({ cwd: "/home/user/my-project", sessionFile: "session-alpha" });
      await runtime.init(ctx1);
      expect(runtime.getActiveAccount()?.id).toBe("personal");

      // Second init: same session key → should restore "personal" from state, not re-cascade
      const runtime2 = new AccountSwitcherRuntime(pi, { accounts: accPath, providers: provPath, state: statePath });
      const ctx2 = mockCtx({ cwd: "/somewhere/else", sessionFile: "session-alpha" });
      await runtime2.init(ctx2);

      // Even though cwd is unrelated now, session state from first init should persist
      expect(runtime2.getActiveAccount()?.id).toBe("personal");
    });
  });
});
