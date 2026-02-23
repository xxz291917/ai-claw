export type MemoryCategory = "preference" | "decision" | "fact" | "todo";

export type MemoryItem = {
  id: number;
  userId: string;
  category: MemoryCategory;
  key: string;
  value: string;
  sourceSessionId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ExtractedMemory = {
  category: MemoryCategory;
  key: string;
  value: string;
};
