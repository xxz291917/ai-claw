import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import AdmZip from "adm-zip";
import {
  validateSlug,
  safeSkillPath,
  readLockFile,
  installSkill,
  uninstallSkill,
  searchSkills,
} from "../../src/chat/clawhub.js";

/** Build a zip Buffer containing the given files. */
function buildZip(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content, "utf-8"));
  }
  return zip.toBuffer();
}

const tmpDir = resolve("/tmp", `clawhub-test-${process.pid}`);

beforeEach(() => mkdirSync(tmpDir, { recursive: true }));
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// validateSlug
// ---------------------------------------------------------------------------

describe("validateSlug", () => {
  it("accepts valid slugs", () => {
    expect(() => validateSlug("github")).not.toThrow();
    expect(() => validateSlug("my-skill")).not.toThrow();
    expect(() => validateSlug("skill_v2")).not.toThrow();
    expect(() => validateSlug("A123")).not.toThrow();
  });

  it("rejects path traversal attempts", () => {
    expect(() => validateSlug("../etc/passwd")).toThrow("Invalid skill slug");
    expect(() => validateSlug("../evil")).toThrow("Invalid skill slug");
  });

  it("rejects empty or too-long slugs", () => {
    expect(() => validateSlug("")).toThrow("Invalid skill slug");
    expect(() => validateSlug("a".repeat(65))).toThrow("Invalid skill slug");
  });

  it("rejects slugs with special characters", () => {
    expect(() => validateSlug("skill/name")).toThrow("Invalid skill slug");
    expect(() => validateSlug("skill name")).toThrow("Invalid skill slug");
    expect(() => validateSlug("skill.name")).toThrow("Invalid skill slug");
  });
});

// ---------------------------------------------------------------------------
// safeSkillPath
// ---------------------------------------------------------------------------

describe("safeSkillPath", () => {
  it("returns path within installDir", () => {
    const p = safeSkillPath(tmpDir, "my-skill");
    expect(p).toBe(join(tmpDir, "my-skill"));
  });

  it("throws if path escapes directory", () => {
    expect(() => safeSkillPath("/tmp/a", "../b")).toThrow(
      "escapes install directory",
    );
  });
});

// ---------------------------------------------------------------------------
// readLockFile
// ---------------------------------------------------------------------------

describe("readLockFile", () => {
  it("returns empty lock when file does not exist", () => {
    const lock = readLockFile(tmpDir);
    expect(lock).toEqual({ version: 1, skills: {} });
  });

  it("reads existing lockfile", () => {
    const dir = join(tmpDir, ".clawhub");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "lock.json"),
      JSON.stringify({
        version: 1,
        skills: {
          github: { slug: "github", tag: "v1.0", installedAt: "2026-01-01T00:00:00Z" },
        },
      }),
    );
    const lock = readLockFile(tmpDir);
    expect(lock.skills["github"]?.tag).toBe("v1.0");
  });
});

// ---------------------------------------------------------------------------
// installSkill
// ---------------------------------------------------------------------------

describe("installSkill", () => {
  /** Mock fetch: first call returns metadata, second returns zip buffer */
  function mockFetchForInstall(tag: string, zipBuf: Buffer) {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            slug: "demo",
            name: "Demo",
            latestVersion: { version: tag },
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
  }

  it("downloads zip and extracts all files", async () => {
    const skillContent = "---\nname: demo\n---\n# Demo";
    const indexContent = "console.log('demo');";
    const zipBuf = buildZip({
      "SKILL.md": skillContent,
      "index.js": indexContent,
      "_meta.json": '{"slug":"demo"}',
    });
    mockFetchForInstall("v1.0", zipBuf);

    const result = await installSkill(tmpDir, "demo");
    expect(result.tag).toBe("v1.0");
    expect(result.alreadyInstalled).toBe(false);

    // SKILL.md and index.js should be extracted
    expect(readFileSync(join(tmpDir, "demo", "SKILL.md"), "utf-8")).toBe(skillContent);
    expect(readFileSync(join(tmpDir, "demo", "index.js"), "utf-8")).toBe(indexContent);

    // _meta.json should be skipped
    expect(existsSync(join(tmpDir, "demo", "_meta.json"))).toBe(false);

    const lock = readLockFile(tmpDir);
    expect(lock.skills["demo"]?.tag).toBe("v1.0");
  });

  it("extracts files in subdirectories", async () => {
    const zipBuf = buildZip({
      "SKILL.md": "# Demo",
      "scripts/test.js": "// test",
    });
    mockFetchForInstall("v1.0", zipBuf);

    await installSkill(tmpDir, "demo");
    expect(readFileSync(join(tmpDir, "demo", "scripts", "test.js"), "utf-8")).toBe("// test");
  });

  it("clears old files on upgrade", async () => {
    // Pre-install an old version with an extra file
    mkdirSync(join(tmpDir, "demo"), { recursive: true });
    writeFileSync(join(tmpDir, "demo", "old-file.txt"), "stale");

    const zipBuf = buildZip({ "SKILL.md": "# v2" });
    mockFetchForInstall("v2.0", zipBuf);

    await installSkill(tmpDir, "demo");
    // Old file should be gone
    expect(existsSync(join(tmpDir, "demo", "old-file.txt"))).toBe(false);
    expect(readFileSync(join(tmpDir, "demo", "SKILL.md"), "utf-8")).toBe("# v2");
  });

  it("reports alreadyInstalled when tag matches", async () => {
    mkdirSync(join(tmpDir, ".clawhub"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".clawhub", "lock.json"),
      JSON.stringify({
        version: 1,
        skills: { demo: { slug: "demo", tag: "v2.0", installedAt: "2026-01-01" } },
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          slug: "demo",
          name: "Demo",
          latestVersion: { version: "v2.0" },
        }),
      }),
    );

    const result = await installSkill(tmpDir, "demo");
    expect(result.alreadyInstalled).toBe(true);
    expect(result.tag).toBe("v2.0");
  });

  it("throws on 404 from registry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
      }),
    );
    await expect(installSkill(tmpDir, "nonexistent")).rejects.toThrow(
      "not found",
    );
  });
});

// ---------------------------------------------------------------------------
// uninstallSkill
// ---------------------------------------------------------------------------

describe("uninstallSkill", () => {
  it("removes skill directory and lockfile entry", () => {
    mkdirSync(join(tmpDir, "old-skill"), { recursive: true });
    writeFileSync(join(tmpDir, "old-skill", "SKILL.md"), "content");
    mkdirSync(join(tmpDir, ".clawhub"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".clawhub", "lock.json"),
      JSON.stringify({
        version: 1,
        skills: {
          "old-skill": { slug: "old-skill", tag: "v1.0", installedAt: "2026-01-01" },
        },
      }),
    );

    uninstallSkill(tmpDir, "old-skill");
    expect(existsSync(join(tmpDir, "old-skill"))).toBe(false);
    expect(readLockFile(tmpDir).skills["old-skill"]).toBeUndefined();
  });

  it("throws if skill not installed", () => {
    expect(() => uninstallSkill(tmpDir, "nonexistent")).toThrow(
      "not installed",
    );
  });
});

// ---------------------------------------------------------------------------
// searchSkills
// ---------------------------------------------------------------------------

describe("searchSkills", () => {
  it("returns formatted search results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          results: [
            { slug: "jira", name: "Jira", description: "Issue management", tags: ["pm"] },
            { slug: "linear", name: "Linear", description: "Project tracking" },
          ],
        }),
      }),
    );

    const results = await searchSkills("project");
    expect(results).toHaveLength(2);
    expect(results[0].slug).toBe("jira");
    expect(results[0].tags).toEqual(["pm"]);
    expect(results[1].slug).toBe("linear");
  });

  it("throws on empty query", async () => {
    await expect(searchSkills("")).rejects.toThrow("empty");
  });
});
