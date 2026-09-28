import { Router, type IRouter, type Request, type Response } from "express";
import platformsData from "../data/platforms.json";

type Platform = { name: string; url: string };
type ProfileInput = {
  platform: string;
  url?: string;
  display_name?: string;
  bio?: string;
  avatar?: string;
  category?: string;
};

const router: IRouter = Router();
const sites = Object.entries(platformsData).flatMap(([category, entries]) =>
  (entries as Platform[]).map((entry) => ({ ...entry, category })),
);
let savedPrompt = "";
let proxyEnabled = false;

const usernamePattern = /^[a-zA-Z0-9._-]{1,80}$/;
const safeUsername = (value: unknown) => {
  const username = String(value ?? "").trim();
  if (!username || !usernamePattern.test(username)) {
    const error = new Error("Username must use letters, numbers, dots, underscores, or hyphens.");
    Object.assign(error, { status: 400 });
    throw error;
  }
  return username;
};

const safeLimit = (value: unknown) => {
  if (value === undefined || value === "") return sites.length;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 250) {
    const error = new Error("Limit must be an integer between 1 and 250.");
    Object.assign(error, { status: 400 });
    throw error;
  }
  return parsed;
};

const siteUrl = (template: string, username: string) =>
  template.replaceAll("{handle}", encodeURIComponent(username));

async function checkSite(site: Platform & { category: string }, username: string) {
  const url = siteUrl(site.url, username);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": "deepkrak3n-public-profile-check/1.0" },
    });
    const text = (await response.text()).slice(0, 200_000).toLowerCase();
    const found = response.status === 200 && text.includes(username.toLowerCase());
    let state = found ? "found" : "unknown";
    let reason = found ? "Username present" : "Unable to confirm";
    if (response.status === 404) {
      state = "not_found";
      reason = "Profile not found";
    } else if (response.status === 403) {
      state = "blocked";
      reason = "Access forbidden";
    } else if (response.status === 429) {
      state = "rate_limited";
      reason = "Rate limited";
    } else if (response.status >= 500) {
      state = "server_error";
      reason = "Server error";
    }
    return {
      site: site.name,
      url,
      found,
      state,
      status_code: response.status,
      via_proxy: false,
      proxy_id: null,
      latency_ms: Math.round(performance.now() - started),
      reason,
      category: site.category,
    };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return {
      site: site.name,
      url,
      found: false,
      state: timedOut ? "timeout" : "network_error",
      status_code: 0,
      via_proxy: false,
      proxy_id: null,
      latency_ms: null,
      reason: timedOut ? "Timeout" : "Network error",
      category: site.category,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function search(username: string, limit: number, onResult?: (result: unknown) => void) {
  const selected = sites.slice(0, limit);
  const results: unknown[] = [];
  let next = 0;
  const worker = async () => {
    while (next < selected.length) {
      const index = next++;
      const result = await checkSite(selected[index], username);
      results[index] = result;
      onResult?.(result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, selected.length) }, worker));
  const ordered = results as Array<Awaited<ReturnType<typeof checkSite>>>;
  return {
    query: username,
    total_checked: ordered.length,
    total_found: ordered.filter((result) => result.found).length,
    found_profiles: ordered.filter((result) => result.found),
    all_results: ordered,
  };
}

router.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "deepkrak3n" });
});

router.post("/search/username", async (req, res) => {
  try {
    const username = safeUsername(req.query.username);
    const limit = safeLimit(req.query.limit);
    res.json(await search(username, limit));
  } catch (error) {
    const status = (error as { status?: number }).status ?? 500;
    res.status(status).json({ detail: status === 500 ? "Search unavailable" : (error as Error).message });
  }
});

router.get("/search/username/stream", async (req: Request, res: Response) => {
  let username: string;
  let limit: number;
  try {
    username = safeUsername(req.query.username);
    limit = safeLimit(req.query.limit);
  } catch (error) {
    const status = (error as { status?: number }).status ?? 400;
    res.status(status).json({ detail: (error as Error).message });
    return;
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let closed = false;
  req.on("close", () => {
    closed = true;
  });
  const send = (event: string, data: unknown) => {
    if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const result = await search(username, limit, (siteResult) => send("site_result", { type: "site_result", result: siteResult }));
    send("search_complete", {
      type: "search_complete",
      summary: { total_found: result.total_found, total_checked: result.total_checked },
      found_profiles: result.found_profiles,
    });
  } catch {
    send("error", { type: "error", error: "Search unavailable" });
  } finally {
    if (!res.writableEnded) res.end();
  }
});

router.get("/network/status", (_req, res) => {
  res.json({ proxy_enabled: proxyEnabled, proxy: { enabled: proxyEnabled, count: 0 }, direct_ip: null, proxy_ip: null });
});

router.post("/proxy/toggle", (req, res) => {
  proxyEnabled = String(req.query.enabled ?? req.body?.enabled) === "true";
  res.json({ proxy_enabled: false, proxy_count: 0, auto_fetch_attempted: false, message: "Proxy support is disabled in this standalone public-data service." });
});

router.post("/prompt", (req, res) => {
  const prompt = String(req.body?.prompt ?? "").trim();
  if (!prompt) {
    res.status(400).json({ detail: "prompt cannot be empty" });
    return;
  }
  savedPrompt = prompt;
  res.json({ saved: true, bytes: prompt.length, prompt: savedPrompt });
});

router.get("/ollama/models", async (req, res) => {
  const host = String(req.query.host ?? "http://localhost:11434").replace(/\/$/, "");
  try {
    const response = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("Ollama unavailable");
    const data = (await response.json()) as { models?: Array<{ name?: string }> };
    res.json({ host, models: (data.models ?? []).map((model) => model.name).filter(Boolean) });
  } catch {
    res.status(502).json({ detail: "Unable to reach Ollama" });
  }
});

router.post("/profile/analyze", async (req, res) => {
  const profiles = Array.isArray(req.body?.profiles) ? (req.body.profiles as ProfileInput[]) : [];
  if (!profiles.length) {
    res.status(400).json({ detail: "profiles required" });
    return;
  }
  const unique = profiles.filter((profile, index, list) =>
    list.findIndex((candidate) => candidate.platform === profile.platform && candidate.url === profile.url) === index,
  );
  const platforms = unique.map((profile) => profile.platform.toLowerCase());
  const bios = unique.map((profile) => profile.bio ?? "");
  const traits: string[] = [];
  const risks: string[] = [];
  if (platforms.some((platform) => /github|gitlab|bitbucket/.test(platform))) traits.push("developer/tech footprint");
  if (platforms.some((platform) => platform.includes("linkedin"))) traits.push("professional identity");
  if (platforms.some((platform) => /instagram|facebook|tiktok/.test(platform))) traits.push("social presence");
  if (platforms.some((platform) => /patreon|ko-fi|gumroad|buy me/.test(platform))) traits.push("creator/monetization signals");
  if (bios.some((bio) => bio.length > 240)) traits.push("long-form bio detected");
  if (new Set(platforms).size <= 2 && unique.length >= 3) risks.push("identity reuse across few platforms");
  if (bios.some((bio) => /vpn|proxy/i.test(bio))) risks.push("privacy tooling mentioned");
  res.json({
    summary: `Found ${unique.length} profiles across ${new Set(platforms).size} platforms. Signals combined into high-level traits and risks.`,
    traits,
    risks,
    mode: "heuristic",
    llm_used: false,
    llm_error: req.body?.use_llm ? "LLM analysis is unavailable until a local Ollama instance is configured." : null,
  });
});

export default router;