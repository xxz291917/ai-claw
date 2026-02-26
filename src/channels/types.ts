import type { Hono } from "hono";
import type { ConversationResult } from "../chat/conversation.js";
import type { ChatEvent } from "../chat/types.js";
import type { SessionManager } from "../sessions/manager.js";
import type { MemoryManager } from "../memory/manager.js";
import type { EventLog } from "../core/event-bus.js";

export type InboundMessage = {
  userId: string;
  text: string;
  channel: string;
  channelId: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
};

export type OnEventCallback = (event: ChatEvent) => void | Promise<void>;

export type ChannelContext = {
  app: Hono;
  handleMessage: (
    msg: InboundMessage,
    onEvent?: OnEventCallback,
  ) => Promise<ConversationResult>;
  sessionManager: SessionManager;
  memoryManager?: MemoryManager;
  eventLog: EventLog;
};

export interface Channel {
  readonly name: string;
  start(ctx: ChannelContext): Promise<void>;
  stop?(): Promise<void>;
}
