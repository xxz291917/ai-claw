import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import AdmZip from "adm-zip";
import { handleCommand } from "../../src/chat/commands.js";
import { SessionManager } from "../../src/sessions/manager.js";
import { createTestDb } from "../helpers.js";

const tmpInstallDir = resolve("/tmp", `cmd-test-${process.pid}`);

beforeEach(() => mkdirSync(tmpInstallDir, { recursive: true }));
afterEach(() => {
  rmSync(tmpInstallDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function setup() {
  const db = createTestDb();
  const sessionManager = new SessionManager(db);
  const session = sessionManager.create({
    userId: "user-1",
    channel: "web",
    channelId: "",
    provider: "test",
  });
  sessionManager.appendMessage(session.id, { role: "user", content: "hello" });
  sessionManager.appendMessage(session.id, {
    role: "assistant",
    content: "hi",
  });
  return { sessionManager, session };
}

function ctx(s: ReturnType<typeof setup>) {
  return {
    session: s.session,
    sessionManager: s.sessionManager,
    providerName: "test",
    installDir: tmpInstallDir,
    skillsDirs: ["/tmp/test-skills", tmpInstallDir],
  };
}

describe("handleCommand", () => {
  it("returns null for non-command messages", async () => {
    const s = setup();
    const result = await handleCommand("hello", ctx(s));
    expect(result).toBeNull();
  });

  it("returns null for unknown commands", async () => {
    const s = setup();
    const result = await handleCommand("/unknown", ctx(s));
    expect(result).toBeNull();
  });

  it("/new closes current session and creates a new one", async () => {
    const s = setup();
    const result = await handleCommand("/new", ctx(s));

    expect(result).toBeTruthy();
    expect(result!.newSession).toBeTruthy();
    expect(result!.newSession!.id).not.toBe(s.session.id);
    expect(result!.events[0]).toMatchObject({
      type: "text",
      content: "New session started.",
    });

    const old = s.sessionManager.getById(s.session.id);
    expect(old!.status).toBe("closed");
  });

  it("/reset clears messages", async () => {
    const s = setup();
    expect(s.sessionManager.countMessages(s.session.id)).toBe(2);

    const result = await handleCommand("/reset", ctx(s));

    expect(result).toBeTruthy();
    expect(result!.events[0].type).toBe("text");
    expect((result!.events[0] as any).content).toContain("2 messages cleared");
    expect(s.sessionManager.countMessages(s.session.id)).toBe(0);
  });

  it("/status returns session info", async () => {
    const s = setup();
    const result = await handleCommand("/status", ctx(s));

    expect(result).toBeTruthy();
    const text = (result!.events[0] as any).content;
    expect(text).toContain(s.session.id);
    expect(text).toContain("Provider: test");
    expect(text).toContain("Messages: 2");
  });

  it("commands are case-insensitive", async () => {
    const s = setup();
    const result = await handleCommand("/STATUS", ctx(s));
    expect(result).toBeTruthy();
  });

  it("/skills lists available skills", async () => {
    const s = setup();
    // Install a skill so there's something to list
    mkdirSync(join(tmpInstallDir, "demo"), { recursive: true });
    writeFileSync(
      join(tmpInstallDir, "demo", "SKILL.md"),
      "---\nname: demo\ndescription: A demo skill\n---\n# Demo",
    );

    const result = await handleCommand("/skills", ctx(s));
    expect(result).toBeTruthy();
    const text = (result!.events[0] as any).content;
    expect(text).toContain("demo");
    expect(text).toContain("A demo skill");
  });

  it("/help lists available commands", async () => {
    const s = setup();
    const result = await handleCommand("/help", ctx(s));
    expect(result).toBeTruthy();
    const text = (result!.events[0] as any).content;
    expect(text).toContain("/new");
    expect(text).toContain("/skills");
    expect(text).toContain("/install");
    expect(text).toContain("/search");
  });
});

// ---------------------------------------------------------------------------
// ClawHub skill commands
// ---------------------------------------------------------------------------

describe("handleCommand — /install", () => {
  it("returns usage when no slug provided", async () => {
    const s = setup();
    const result = await handleCommand("/install", ctx(s));
    expect(result).toBeTruthy();
    expect((result!.events[0] as any).content).toContain("Usage:");
  });

  it("installs a skill from registry", async () => {
    const s = setup();
    const zip = new AdmZip();
    zip.addFile("SKILL.md", Buffer.from("---\nname: demo\n---\n# Demo"));
    const zipBuf = zip.toBuffer();

    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            slug: "demo",
            name: "Demo",
            latestVersion: { version: "v1.0" },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          arrayBuffer: async () => zipBuf.buffer.slice(
            zipBuf.byteOffset,
            zipBuf.byteOffset + zipBuf.byteLength,
          ),
        }),
    );

    const result = await handleCommand("/install demo", ctx(s));
    expect(result).toBeTruthy();
    expect((result!.events[0] as any).content).toContain("Installed");
    expect(existsSync(join(tmpInstallDir, "demo", "SKILL.md"))).toBe(true);
  });

  it("reports error on failure", async () => {
    const s = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
      }),
    );

    const result = await handleCommand("/install nonexistent", ctx(s));
    expect(result).toBeTruthy();
    expect((result!.events[0] as any).content).toContain("Install failed");
  });
});

describe("handleCommand — /uninstall", () => {
  it("returns usage when no slug provided", async () => {
    const s = setup();
    const result = await handleCommand("/uninstall", ctx(s));
    expect(result).toBeTruthy();
    expect((result!.events[0] as any).content).toContain("Usage:");
  });

  it("uninstalls an installed skill", async () => {
    const s = setup();
    mkdirSync(join(tmpInstallDir, "old-skill"), { recursive: true });
    writeFileSync(join(tmpInstallDir, "old-skill", "SKILL.md"), "content");

    const result = await handleCommand("/uninstall old-skill", ctx(s));
    expect(result).toBeTruthy();
    expect((result!.events[0] as any).content).toContain("Uninstalled");
    expect(existsSync(join(tmpInstallDir, "old-skill"))).toBe(false);
  });

  it("reports error for non-installed skill", async () => {
    const s = setup();
    const result = await handleCommand("/uninstall ghost", ctx(s));
    expect(result).toBeTruthy();
    expect((result!.events[0] as any).content).toContain("Uninstall failed");
  });
});

describe("handleCommand — /search", () => {
  it("returns usage when no query provided", async () => {
    const s = setup();
    const result = await handleCommand("/search", ctx(s));
    expect(result).toBeTruthy();
    expect((result!.events[0] as any).content).toContain("Usage:");
  });

  it("returns formatted search results", async () => {
    const s = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            { slug: "jira", name: "Jira", description: "Issue mgmt", tags: ["pm"] },
          ],
        }),
      }),
    );

    const result = await handleCommand("/search jira", ctx(s));
    expect(result).toBeTruthy();
    expect((result!.events[0] as any).content).toContain("jira");
    expect((result!.events[0] as any).content).toContain("/install");
  });

  it("handles no results", async () => {
    const s = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ results: [] }),
      }),
    );

    const result = await handleCommand("/search nonexistent-xyz", ctx(s));
    expect(result).toBeTruthy();
    expect((result!.events[0] as any).content).toContain("No skills found");
  });
});
