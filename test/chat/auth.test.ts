import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { parseChatUsers, chatAuthMiddleware } from "../../src/chat/auth.js";

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

describe("chatAuthMiddleware", () => {
  function createApp(chatUsers: string | undefined) {
    const users = parseChatUsers(chatUsers);
    const app = new Hono();
    app.use("/api/chat", chatAuthMiddleware(users));
    app.post("/api/chat", (c) => {
      return c.json({ userId: c.get("userId") });
    });
    return app;
  }

  it("anonymous mode: no CHAT_USERS → userId is web-anonymous", async () => {
    const app = createApp(undefined);
    const res = await app.request("/api/chat", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe("web-anonymous");
  });

  it("auth mode: valid token → userId is matched name", async () => {
    const app = createApp("alice:tok123");
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { Authorization: "Bearer tok123" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.userId).toBe("alice");
  });

  it("auth mode: missing token → 401", async () => {
    const app = createApp("alice:tok123");
    const res = await app.request("/api/chat", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("auth mode: invalid token → 401", async () => {
    const app = createApp("alice:tok123");
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { Authorization: "Bearer wrong_token" },
    });
    expect(res.status).toBe(401);
  });

  it("auth mode: malformed Authorization header → 401", async () => {
    const app = createApp("alice:tok123");
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: { Authorization: "Basic abc" },
    });
    expect(res.status).toBe(401);
  });
});
