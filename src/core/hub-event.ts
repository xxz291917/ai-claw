import { randomUUID } from "node:crypto";

export type HubEvent = {
  id: string;
  type: string;
  source: string;
  payload: Record<string, any>;
  metadata: {
    receivedAt: string;
    traceId?: string;
  };
  context?: {
    sessionId?: string;
    userId?: string;
    replyTo?: string;
  };
};

export type CreateHubEventParams = {
  type: string;
  source: string;
  payload: Record<string, any>;
  context?: HubEvent["context"];
  traceId?: string;
};

export function createHubEvent(params: CreateHubEventParams): HubEvent {
  return {
    id: randomUUID(),
    type: params.type,
    source: params.source,
    payload: params.payload,
    metadata: {
      receivedAt: new Date().toISOString(),
      traceId: params.traceId,
    },
    context: params.context,
  };
}
