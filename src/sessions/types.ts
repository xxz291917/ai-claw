export type Session = {
  id: string;
  userId: string;
  channel: string;
  channelId: string;
  provider: string;
  providerSessionId: string | null;
  status: "active" | "closed";
  createdAt: string;
  lastActiveAt: string;
};

export type MessageType = "message" | "summary";

export type Message = {
  id: number;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  type: MessageType;
  createdAt: string;
};
