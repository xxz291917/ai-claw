import type { SubAgent } from "./types.js";

export class AgentRegistry {
  private agents = new Map<string, SubAgent>();

  constructor(agents: SubAgent[]) {
    for (const agent of agents) {
      this.agents.set(agent.name, agent);
    }
  }

  get(name: string): SubAgent | undefined {
    return this.agents.get(name);
  }

  list(): Array<{ name: string; description: string }> {
    return [...this.agents.values()].map((a) => ({
      name: a.name,
      description: a.description,
    }));
  }
}
