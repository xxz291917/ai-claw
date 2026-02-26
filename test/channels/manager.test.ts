import { describe, it, expect } from "vitest";
import { ChannelManager } from "../../src/channels/manager.js";
import type { Channel, ChannelContext } from "../../src/channels/types.js";

function fakeChannel(name: string): Channel & { started: boolean; stopped: boolean } {
  return {
    name,
    started: false,
    stopped: false,
    async start() { this.started = true; },
    async stop() { this.stopped = true; },
  };
}

describe("ChannelManager", () => {
  it("registers and starts all channels", async () => {
    const manager = new ChannelManager();
    const ch1 = fakeChannel("web");
    const ch2 = fakeChannel("lark");

    manager.register(ch1);
    manager.register(ch2);

    await manager.startAll({} as ChannelContext);

    expect(ch1.started).toBe(true);
    expect(ch2.started).toBe(true);
  });

  it("stops all channels", async () => {
    const manager = new ChannelManager();
    const ch = fakeChannel("web");
    manager.register(ch);
    await manager.startAll({} as ChannelContext);
    await manager.stopAll();
    expect(ch.stopped).toBe(true);
  });

  it("list() returns registered channel names", () => {
    const manager = new ChannelManager();
    manager.register(fakeChannel("web"));
    manager.register(fakeChannel("lark"));
    expect(manager.list()).toEqual(["web", "lark"]);
  });
});
