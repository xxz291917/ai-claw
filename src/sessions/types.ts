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

export type Message = {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls: string | null;
  createdAt: string;
};
