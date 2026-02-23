import { z } from "zod";
import type { UnifiedToolDef } from "./types.js";

const DEFAULT_MAX_CHARS = 50_000;
const DEFAULT_USER_AGENT = "Mozilla/5.0 (compatible; AI-Hub/1.0)";
const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v1/scrape";
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

type CacheEntry = { data: string; ts: number };
const cache = new Map<string, CacheEntry>();

type WebFetchConfig = {
  firecrawlApiKey?: string;
};

/**
 * Creates a web_fetch tool that fetches and extracts readable content from URLs.
 * Uses Firecrawl API when available, falls back to basic HTML stripping.
 * Results are cached for 15 minutes.
 */
export function createWebFetchTool(config: WebFetchConfig = {}): UnifiedToolDef {
  return {
    name: "web_fetch",
    description:
      "Fetch and extract readable content from a URL. Converts HTML to clean text. " +
      "Use this to read articles, documentation, blog posts, or any web page.",
    inputSchema: {
      url: z.string().describe("HTTP or HTTPS URL to fetch"),
      maxChars: z
        .number()
        .optional()
        .describe("Maximum characters to return (default 50000)"),
    },
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTP or HTTPS URL to fetch" },
        maxChars: { type: "number", description: "Maximum characters to return (default 50000)" },
      },
      required: ["url"],
    },
    execute: async (args: { url: string; maxChars?: number }, _ctx) => {
      return fetchUrl(args.url, args.maxChars, config.firecrawlApiKey);
    },
  };
}

async function fetchUrl(
  url: string,
  maxChars?: number,
  firecrawlApiKey?: string,
): Promise<string> {
  const limit = maxChars ?? DEFAULT_MAX_CHARS;
  const cacheKey = `${url}|${limit}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  let content: string;

  // Try Firecrawl first if API key is available
  if (firecrawlApiKey) {
    try {
      content = await fetchWithFirecrawl(url, firecrawlApiKey);
      if (content) {
        const result = truncate(content, limit);
        cache.set(cacheKey, { data: result, ts: Date.now() });
        evictStale();
        return result;
      }
    } catch {
      // Fall through to basic fetch
    }
  }

  // Fallback: direct fetch + HTML stripping
  content = await fetchDirect(url);
  const result = truncate(content, limit);
  cache.set(cacheKey, { data: result, ts: Date.now() });
  evictStale();
  return result;
}

async function fetchWithFirecrawl(
  url: string,
  apiKey: string,
): Promise<string> {
  validateUrl(url);
  const res = await fetch(FIRECRAWL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ["markdown"],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    throw new Error(`Firecrawl error: ${res.status}`);
  }

  const data: any = await res.json();
  return data.data?.markdown ?? data.data?.content ?? "";
}

function validateUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http/https URLs are allowed, got: ${parsed.protocol}`);
  }
  // Block common SSRF targets (cloud metadata, localhost, private ranges)
  const host = parsed.hostname;
  if (
    host === "localhost" ||
    host === "169.254.169.254" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host === "0.0.0.0" ||
    host === "[::1]"
  ) {
    throw new Error(`Access to internal/private addresses is blocked: ${host}`);
  }
}

async function fetchDirect(url: string): Promise<string> {
  validateUrl(url);
  const res = await fetch(url, {
    headers: { "User-Agent": DEFAULT_USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    return `Failed to fetch: ${res.status} ${res.statusText}`;
  }

  const contentType = res.headers.get("content-type") ?? "";

  // JSON: pretty-print
  if (contentType.includes("application/json")) {
    const json = await res.json();
    return JSON.stringify(json, null, 2);
  }

  const html = await res.text();

  // Plain text: return as-is
  if (!contentType.includes("html")) {
    return html;
  }

  // HTML: strip tags
  return stripHtml(html);
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n[Truncated — content exceeded limit]";
}

function evictStale(): void {
  for (const [key, entry] of cache) {
    if (Date.now() - entry.ts > CACHE_TTL_MS) cache.delete(key);
  }
}
