import type { Channel, ChannelContext } from "./types.js";

export class ChannelManager {
  private channels: Channel[] = [];

  register(channel: Channel): void {
    this.channels.push(channel);
  }

  async startAll(ctx: ChannelContext): Promise<void> {
    for (const ch of this.channels) {
      await ch.start(ctx);
      console.log(`[channel] ${ch.name} started`);
    }
  }

  async stopAll(): Promise<void> {
    for (const ch of this.channels) {
      await ch.stop?.();
    }
  }

  list(): string[] {
    return this.channels.map((ch) => ch.name);
  }
}
