import { z } from "zod";

const BRAVE_SEARCH_ENDPOINT =
  "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_COUNT = 5;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

type CacheEntry = { data: string; ts: number };
const cache = new Map<string, CacheEntry>();

type WebSearchConfig = {
  apiKey: string;
};

/**
 * Creates a web_search tool that queries Brave Search API.
 * Results are cached for 15 minutes.
 */
export function createWebSearchTool(config: WebSearchConfig) {
  return {
    name: "web_search",
    description:
      "Search the web for current information, news, documentation, or any topic. " +
      "Returns search results with titles, URLs, and snippets. " +
      "Use this when you need up-to-date information beyond your training data.",
    inputSchema: {
      query: z
        .string()
        .describe("Search query string"),
      count: z
        .number()
        .optional()
        .describe("Number of results (1-10, default 5)"),
    },
    handler: async (args: { query: string; count?: number }) => {
      const text = await search(config.apiKey, args.query, args.count);
      return { content: [{ type: "text" as const, text }] };
    },
    plainHandler: async (args: {
      query: string;
      count?: number;
    }): Promise<string> => {
      return search(config.apiKey, args.query, args.count);
    },
  };
}

async function search(
  apiKey: string,
  query: string,
  count?: number,
): Promise<string> {
  const cacheKey = `${query}|${count ?? DEFAULT_COUNT}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  const params = new URLSearchParams({
    q: query,
    count: String(count ?? DEFAULT_COUNT),
  });

  const res = await fetch(`${BRAVE_SEARCH_ENDPOINT}?${params}`, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!res.ok) {
    return `Brave Search API error: ${res.status} ${res.statusText}`;
  }

  const data: any = await res.json();
  const results: any[] = data.web?.results ?? [];

  if (results.length === 0) {
    return "No results found.";
  }

  const formatted = results
    .map(
      (r: any, i: number) =>
        `${i + 1}. **${r.title ?? "Untitled"}**\n   ${r.url}\n   ${r.description ?? ""}`,
    )
    .join("\n\n");

  cache.set(cacheKey, { data: formatted, ts: Date.now() });

  // Evict stale entries
  for (const [key, entry] of cache) {
    if (Date.now() - entry.ts > CACHE_TTL_MS) cache.delete(key);
  }

  return formatted;
}
