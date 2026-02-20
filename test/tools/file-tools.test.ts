import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  safePath,
  createFileTools,
} from "../../src/tools/file-tools.js";
import type { UnifiedToolDef } from "../../src/tools/types.js";

let workspace: string;

beforeEach(() => {
  workspace = resolve(tmpdir(), `file-tools-test-${randomUUID()}`);
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// safePath
// ---------------------------------------------------------------------------
describe("safePath", () => {
  it("resolves relative path within workspace", () => {
    const result = safePath("src/foo.ts", workspace);
    expect(result).toBe(resolve(workspace, "src/foo.ts"));
  });

  it("rejects path traversal with ../", () => {
    expect(() => safePath("../../etc/passwd", workspace)).toThrow(
      "Path outside workspace",
    );
  });

  it("rejects absolute path outside workspace", () => {
    expect(() => safePath("/etc/passwd", workspace)).toThrow(
      "Path outside workspace",
    );
  });
});

// ---------------------------------------------------------------------------
// file_read
// ---------------------------------------------------------------------------
describe("file_read", () => {
  let tools: UnifiedToolDef[];
  let fileRead: UnifiedToolDef;

  beforeEach(() => {
    tools = createFileTools({ workspaceDir: workspace });
    fileRead = tools.find((t) => t.name === "file_read")!;
    expect(fileRead).toBeDefined();
  });

  it("reads file with line numbers", async () => {
    writeFileSync(join(workspace, "hello.txt"), "line1\nline2\nline3\n");

    const result = await fileRead.execute({ path: "hello.txt" });

    expect(result).toContain("1| line1");
    expect(result).toContain("2| line2");
    expect(result).toContain("3| line3");
  });

  it("supports offset and limit pagination", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join(
      "\n",
    );
    writeFileSync(join(workspace, "ten.txt"), lines);

    const result = await fileRead.execute({
      path: "ten.txt",
      offset: 2,
      limit: 3,
    });

    // offset=2 means skip first 2 lines, so we get lines 3, 4, 5
    expect(result).toContain("3| line-3");
    expect(result).toContain("4| line-4");
    expect(result).toContain("5| line-5");
    expect(result).not.toContain("1| line-1");
    expect(result).not.toContain("2| line-2");
    expect(result).not.toContain("6| line-6");
  });

  it("returns error for nonexistent file", async () => {
    const result = await fileRead.execute({ path: "no-such-file.txt" });
    expect(result.toLowerCase()).toContain("error");
  });

  it("rejects path outside workspace", async () => {
    const result = await fileRead.execute({ path: "../../etc/passwd" });
    expect(result).toContain("Path outside workspace");
  });

  it("truncates output at maxReadBytes", async () => {
    // Create a file larger than the limit
    const bigContent = "x".repeat(200) + "\n";
    writeFileSync(join(workspace, "big.txt"), bigContent);

    const smallTools = createFileTools({
      workspaceDir: workspace,
      maxReadBytes: 100,
    });
    const smallRead = smallTools.find((t) => t.name === "file_read")!;
    const result = await smallRead.execute({ path: "big.txt" });

    expect(result.length).toBeLessThanOrEqual(150); // 100 + truncation notice
    expect(result).toContain("truncated");
  });
});

// ---------------------------------------------------------------------------
// file_write
// ---------------------------------------------------------------------------
describe("file_write", () => {
  let tools: UnifiedToolDef[];
  let fileWrite: UnifiedToolDef;

  beforeEach(() => {
    tools = createFileTools({ workspaceDir: workspace });
    fileWrite = tools.find((t) => t.name === "file_write")!;
    expect(fileWrite).toBeDefined();
  });

  it("creates new file", async () => {
    const result = await fileWrite.execute({
      path: "new-file.txt",
      content: "hello world",
    });

    expect(result).toContain("new-file.txt");
    const written = readFileSync(join(workspace, "new-file.txt"), "utf-8");
    expect(written).toBe("hello world");
  });

  it("creates parent directories", async () => {
    const result = await fileWrite.execute({
      path: "deep/nested/file.txt",
      content: "nested content",
    });

    expect(result).toContain("deep/nested/file.txt");
    expect(
      existsSync(join(workspace, "deep/nested/file.txt")),
    ).toBe(true);
    const written = readFileSync(
      join(workspace, "deep/nested/file.txt"),
      "utf-8",
    );
    expect(written).toBe("nested content");
  });

  it("overwrites existing file", async () => {
    writeFileSync(join(workspace, "overwrite.txt"), "old content");

    await fileWrite.execute({
      path: "overwrite.txt",
      content: "new content",
    });

    const written = readFileSync(join(workspace, "overwrite.txt"), "utf-8");
    expect(written).toBe("new content");
  });

  it("rejects path outside workspace", async () => {
    const result = await fileWrite.execute({
      path: "../../etc/evil.txt",
      content: "bad",
    });

    expect(result).toContain("Path outside workspace");
  });
});
