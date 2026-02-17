import { describe, it, expect } from "vitest";
import { parseChatUsers } from "../../src/chat/auth.js";

describe("parseChatUsers", () => {
  it("returns empty map when input is undefined", () => {
    expect(parseChatUsers(undefined)).toEqual(new Map());
  });

  it("returns empty map when input is empty string", () => {
    expect(parseChatUsers("")).toEqual(new Map());
  });

  it("parses single user", () => {
    const map = parseChatUsers("alice:token_abc");
    expect(map.size).toBe(1);
    expect(map.get("token_abc")).toBe("alice");
  });

  it("parses multiple users", () => {
    const map = parseChatUsers("alice:token_abc,bob:token_xyz");
    expect(map.size).toBe(2);
    expect(map.get("token_abc")).toBe("alice");
    expect(map.get("token_xyz")).toBe("bob");
  });

  it("trims whitespace", () => {
    const map = parseChatUsers(" alice : token_abc , bob : token_xyz ");
    expect(map.get("token_abc")).toBe("alice");
    expect(map.get("token_xyz")).toBe("bob");
  });

  it("skips malformed entries", () => {
    const map = parseChatUsers("alice:token_abc,badentry,bob:token_xyz");
    expect(map.size).toBe(2);
  });
});
