"use client";

import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { ChevronDown, Settings, Zap, RefreshCcw, Play, Download, Save, FileText, CheckCircle, X, Eye, ArrowUp } from "lucide-react";
import { motion } from "framer-motion";
import platformsData from "../data/platforms.json";
import logo from "../deepkrak3nlogo.png";

type ResultStatus =
  | "checking"
  | "found"
  | "not_found"
  | "unknown"
  | "blocked"
  | "timeout"
  | "rate_limited"
  | "server_error"
  | "redirect"
  | "error";

interface AvailabilityResult {
  platform: string;
  url: string;
  status: ResultStatus;
  statusCode: number;
  checking: boolean;
  viaProxy?: boolean;
  latencyMs?: number;
  reason?: string | null;
  displayName?: string | null;
  bio?: string | null;
  avatar?: string | null;
}

interface DeepProfileResult {
  platform: string;
  url: string;
  displayName: string;
  bio: string;
  avatar: string;
  category?: string;
}

interface AnalysisResult {
  summary: string;
  traits: string[];
  risks: string[];
  mode: string;
  llm_used?: boolean;
  llm_model?: string;
  llm_error?: string | null;
}

type PlatformCatalog = Record<string, { name: string; url: string }[]>;

const platformCatalog: PlatformCatalog = platformsData as PlatformCatalog;

const platformCategories: Record<string, string[]> = Object.fromEntries(
  Object.entries(platformCatalog).map(([category, entries]) => [category, entries.map((entry) => entry.name)])
);

const platformUrlTemplates: Record<string, string> = Object.fromEntries(
  Object.values(platformCatalog)
    .flat()
    .map((entry) => [entry.name, entry.url])
);

const buildUrlForHandle = (template: string, handle: string) => template.split("{handle}").join(encodeURIComponent(handle));

const getPlatformUrl = (platform: string, handle: string) => {
  const template = platformUrlTemplates[platform];
  if (!template || !handle) return "#";
  return buildUrlForHandle(template, handle);
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://localhost:8000";
const SETTINGS_KEY = "dk3_settings_v3";
type PhaseState = "idle" | "running" | "ready" | "done";
const MAP_WIDTH = 1400;
const MAP_HEIGHT = 950;

const palette = {
  bg: "#06070d",
  panel: "#131521",
  panelDark: "#0c0d14",
  accent: "#353055",
  accentDark: "#292241",
  light: "#9aa0b5",
  border: "#1f2030",
};

const phaseButtonStyle = (enabled: boolean, ready: boolean) => {
  const baseBg = palette.panelDark;
  const baseBorder = palette.border;
  const baseColor = palette.light;
  if (enabled && ready) {
    return {
      backgroundColor: "#065f46",
      border: "1px solid #0f9f6c",
      color: "#e6fff4",
      opacity: 1,
    } as const;
  }
  return {
    backgroundColor: baseBg,
    border: `1px solid ${baseBorder}`,
    color: baseColor,
    opacity: enabled ? 1 : 0.5,
  } as const;
};

const fallbackAvatar = (label: string) => {
  const text = (label || "NF").slice(0, 2).toUpperCase();
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96' viewBox='0 0 96 96'>
    <circle cx='48' cy='48' r='46' fill='#1f2030' stroke='#5256a2' stroke-width='4'/>
    <text x='50%' y='55%' dominant-baseline='middle' text-anchor='middle' fill='#e5e7eb' font-family='Inter,Arial,sans-serif' font-size='30' font-weight='700'>${text}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
};

type AvailabilityStatus = AvailabilityResult["status"];

const statusLabel = (status: AvailabilityStatus, checking: boolean) => {
  if (checking) return "checking";
  const map: Record<AvailabilityStatus, string> = {
    checking: "checking",
    found: "found",
    not_found: "not found",
    unknown: "unknown",
    blocked: "blocked",
    timeout: "timeout",
    rate_limited: "rate limited",
    server_error: "server error",
    redirect: "redirect",
    error: "error",
  };
  return map[status] || status;
};

const statusClasses = (status: AvailabilityStatus, checking: boolean) => {
  if (checking) return "border-sky-500/40 bg-sky-500/10 text-sky-100";
  if (status === "found") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-100";
  if (status === "not_found") return "border-rose-500/40 bg-rose-500/10 text-rose-100";
  if (status === "blocked" || status === "rate_limited" || status === "timeout") return "border-amber-500/40 bg-amber-500/10 text-amber-100";
  return "border-slate-500/40 bg-slate-500/10 text-slate-100";
};

const normalizeAvatar = (avatar: string | undefined, username: string, platform: string): string => {
  if (avatar && avatar.startsWith("http")) return avatar;
  if (avatar && avatar.startsWith("data:")) return avatar;
  return fallbackAvatar(username || platform || "NF");
};

export default function Home() {
  const [queryInput, setQueryInput] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [results, setResults] = useState<AvailabilityResult[]>([]);
  const [foundDetails, setFoundDetails] = useState<AvailabilityResult[]>([]);
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({});
  const [isChecking, setIsChecking] = useState(false);
  const [heuristicResult, setHeuristicResult] = useState<AnalysisResult | null>(null);
  const [llmResult, setLlmResult] = useState<AnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [useLLM, setUseLLM] = useState(true);
  const [llmModel, setLlmModel] = useState("smollm:latest");
  const [ollamaHost, setOllamaHost] = useState("http://localhost:11434");
  const [llmApiMode, setLlmApiMode] = useState("ollama");
  const [analyzerPrompt, setAnalyzerPrompt] = useState("");
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [ollamaStatus, setOllamaStatus] = useState<"idle" | "connecting" | "ready" | "error">("idle");
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [ollamaTestMessage, setOllamaTestMessage] = useState<string | null>(null);
  const [ollamaTestStatus, setOllamaTestStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportingHtml, setExportingHtml] = useState(false);
  const [profileReady, setProfileReady] = useState(false);
  const [phases, setPhases] = useState<{ availability: PhaseState; profile: PhaseState; heuristic: PhaseState; llm: PhaseState }>(
    { availability: "idle", profile: "idle", heuristic: "idle", llm: "idle" }
  );
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [activeProfile, setActiveProfile] = useState<DeepProfileResult | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [previewHtml, setPreviewHtml] = useState("");
  const [availabilityCollapsed, setAvailabilityCollapsed] = useState(false);
  const [profileCheckCollapsed, setProfileCheckCollapsed] = useState(false);
  const [deepAnalysisCollapsed, setDeepAnalysisCollapsed] = useState(false);
  const [llmCollapsed, setLlmCollapsed] = useState(false);
  const [exportCollapsed, setExportCollapsed] = useState(false);
  const [mapZoom, setMapZoom] = useState(1);
  const searchStreamRef = useRef<EventSource | null>(null);
  const [showConnections, setShowConnections] = useState(true);
  const [connectBy, setConnectBy] = useState<"username" | "email" | "profile">("username");
  const [branchMode, setBranchMode] = useState<"all" | "category">("all");
  const [showBackToTop, setShowBackToTop] = useState(false);
  const [mapPan, setMapPan] = useState({ x: 0, y: 0 });
  const panStateRef = useRef({ dragging: false, startX: 0, startY: 0, origX: 0, origY: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [activeBranch, setActiveBranch] = useState<{
    label: string;
    nodes: DeepProfileResult[];
    basis?: { type: string; value: string; note: string };
    viewMode?: "all" | "category" | "likelihood";
    category?: string | null;
  } | null>(null);

  const isSearchInProgress = useMemo(() => isChecking || phases.availability === "running", [isChecking, phases.availability]);

  const foundFromResults = useMemo(
    () => results.filter((r) => r.status === "found" && (r.url || r.displayName)),
    [results]
  );

  const hasInFlightResults = useMemo(
    () => isChecking || results.some((r) => r.checking || r.status === "checking"),
    [isChecking, results]
  );

  const categoryOrder = useMemo(() => Object.keys(platformCategories).map((c) => c.toLowerCase()), []);
  const categoryRank = useMemo(() => {
    const map = new Map<string, number>();
    categoryOrder.forEach((cat, idx) => map.set(cat, idx));
    return map;
  }, [categoryOrder]);

  const likelihoodScore = useCallback(
    (p: { displayName?: string | null; bio?: string | null; url?: string | null }) => {
      const uname = (username || "").toLowerCase();
      const mail = (email || "").toLowerCase();
      const display = (p.displayName || "").toLowerCase();
      const bio = (p.bio || "").toLowerCase();
      const url = (p.url || "").toLowerCase();
      let score = 0;
      if (uname) {
        if (display.includes(uname)) score += 3;
        if (bio.includes(uname)) score += 2;
        if (url.includes(uname)) score += 2;
      }
      if (mail) {
        if (display.includes(mail)) score += 3;
        if (bio.includes(mail)) score += 3;
        if (url.includes(mail)) score += 2;
      }
      return score;
    },
    [username, email]
  );

  useEffect(() => {
    if (hasInFlightResults) {
      setPhases((prev) => (prev.availability === "running" ? prev : { ...prev, availability: "running" }));
      return;
    }

    if (!results.length) return;
    const hasFound = (foundDetails.length ? foundDetails : results).some((r) => r.status === "found" && (r.url || (r as any).displayName));

    setPhases((prev) => {
      const nextAvailability: PhaseState = "done";
      const nextProfile: PhaseState = hasFound ? (prev.profile === "done" ? "done" : "ready") : prev.profile === "done" ? "done" : "idle";
      if (prev.availability === nextAvailability && prev.profile === nextProfile) return prev;
      return { ...prev, availability: nextAvailability, profile: nextProfile };
    });
  }, [hasInFlightResults, results, foundDetails]);

  const deepSectionRef = useRef<HTMLDivElement | null>(null);
  const deepAnalysisSectionRef = useRef<HTMLDivElement | null>(null);
  const analyzerSectionRef = useRef<HTMLDivElement | null>(null);
  const availabilitySectionRef = useRef<HTMLDivElement | null>(null);
  const exportSectionRef = useRef<HTMLDivElement | null>(null);
  const displayedAnalysis = llmResult || heuristicResult;

  const updatePhase = (partial: Partial<typeof phases>) => {
    setPhases((prev) => ({ ...prev, ...partial }));
  };

  const phaseTextClass = (state: PhaseState) => {
    if (state === "done") return "text-emerald-300";
    if (state === "running") return "text-amber-300";
    if (state === "ready") return "text-sky-300";
    return "text-gray-400";
  };

  useEffect(() => {
    const expanded: Record<string, boolean> = {};
    Object.keys(platformCategories).forEach((cat) => {
      expanded[cat] = true;
    });
    setExpandedCategories(expanded);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (typeof saved.useLLM === "boolean") setUseLLM(saved.useLLM);
      if (typeof saved.llmModel === "string") setLlmModel(saved.llmModel);
      if (typeof saved.ollamaHost === "string") setOllamaHost(saved.ollamaHost);
      if (typeof saved.llmApiMode === "string") setLlmApiMode(saved.llmApiMode);
      if (typeof saved.analyzerPrompt === "string") setAnalyzerPrompt(saved.analyzerPrompt);
    } catch (e) {
      console.error("load settings failed", e);
    }
  }, []);

  const connectOllama = async () => {
    setOllamaStatus("connecting");
    setOllamaError(null);
    setOllamaTestMessage(null);
    setOllamaTestStatus("idle");
    try {
      const res = await fetch(`${API_BASE}/api/ollama/models?host=${encodeURIComponent(ollamaHost)}`);
      if (!res.ok) throw new Error("Failed to reach Ollama");
      const data = await res.json();
      setOllamaModels(data.models || []);
      if (data.models?.length) {
        setLlmModel(data.models[0]);
      }
      setOllamaStatus("ready");
    } catch (e) {
      setOllamaStatus("error");
      setOllamaError((e as Error).message);
    }
  };

  const testOllamaConnection = async () => {
    setOllamaTestStatus("testing");
    setOllamaTestMessage(null);
    try {
      const res = await fetch(`${API_BASE}/api/ollama/models?host=${encodeURIComponent(ollamaHost)}`);
      if (!res.ok) throw new Error(`Ollama unreachable (${res.status})`);
      const data = await res.json();
      const models = data.models || [];
      setOllamaTestStatus("success");
      setOllamaTestMessage(models.length ? `Reachable. Models: ${models.slice(0, 3).join(", ")}${models.length > 3 ? "..." : ""}` : "Reachable, but no models returned.");
    } catch (e) {
      setOllamaTestStatus("error");
      setOllamaTestMessage((e as Error).message);
    }
  };

  const saveSettings = async () => {
    if (typeof window === "undefined") return;
    setSavedMessage(null);
    const payload = {
      useLLM,
      llmModel,
      ollamaHost,
      llmApiMode,
      analyzerPrompt,
    };

    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(payload));
    } catch (e) {
      console.error("save settings failed", e);
    }

    let promptSaved = false;
    let promptError: string | null = null;
    const trimmed = analyzerPrompt.trim();
    if (trimmed) {
      try {
        const res = await fetch(`${API_BASE}/api/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: trimmed }),
        });
        if (!res.ok) {
          const detail = await res.json().catch(() => null);
          promptError = detail?.detail || `HTTP ${res.status}`;
        } else {
          promptSaved = true;
        }
      } catch (err) {
        promptError = (err as Error).message;
        console.error("save prompt failed", err);
      }
    }

    if (promptError) {
      setSavedMessage(`Settings saved locally; prompt not persisted (${promptError})`);
    } else if (promptSaved) {
      setSavedMessage("Settings saved • prompt persisted globally");
    } else {
      setSavedMessage("Settings saved");
    }
    setTimeout(() => setSavedMessage(null), 2200);
  };

  const buildInitialResults = (handle: string) => {
    const pending: AvailabilityResult[] = [];
    Object.values(platformCategories).forEach((list) => {
      list.forEach((platform) => {
        pending.push({
          platform,
          url: getPlatformUrl(platform, handle),
          status: "checking",
          statusCode: 0,
          checking: true,
        });
      });
    });
    return pending;
  };

  const upsertResult = (incoming: AvailabilityResult) => {
    setResults((prev) => {
      const next = [...prev];
      const idx = next.findIndex((r) => r.platform === incoming.platform);
      if (idx >= 0) {
        next[idx] = { ...next[idx], ...incoming, checking: false };
      } else {
        next.push({ ...incoming, checking: false });
      }
      return next;
    });
  };

  const stopSearch = () => {
    if (searchStreamRef.current) {
      searchStreamRef.current.close();
      searchStreamRef.current = null;
    }
    setIsChecking(false);
    // Mark any still-checking entries as unknown so the UI doesn't think they are in-flight.
    setResults((prev) =>
      prev.map((r) => ({
        ...r,
        checking: false,
        status: r.status === "checking" ? "unknown" : r.status,
      }))
    );
  };

  useEffect(() => {
    return () => stopSearch({ keepPhase: true });
  }, []);

  const handleMapMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    panStateRef.current = {
      dragging: true,
      startX: e.clientX,
      startY: e.clientY,
      origX: mapPan.x,
      origY: mapPan.y,
    };
    setIsPanning(true);
  };

  const handleMapMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!panStateRef.current.dragging) return;
    const dx = e.clientX - panStateRef.current.startX;
    const dy = e.clientY - panStateRef.current.startY;
    setMapPan({ x: panStateRef.current.origX + dx, y: panStateRef.current.origY + dy });
  };

  const handleMapMouseUp = () => {
    panStateRef.current.dragging = false;
    setIsPanning(false);
  };

  const handleMapDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const currentScale = mapZoom;
    const svgPointX = (clickX - mapPan.x) / currentScale;
    const svgPointY = (clickY - mapPan.y) / currentScale;
    const nextScale = Math.min(3, mapZoom + 0.25);
    const newPanX = rect.width / 2 - svgPointX * nextScale;
    const newPanY = rect.height / 2 - svgPointY * nextScale;
    setMapZoom(nextScale);
    setMapPan({ x: newPanX, y: newPanY });
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const activeRun =
      isSearchInProgress ||
      isAnalyzing ||
      phases.profile === "running" ||
      phases.heuristic === "running" ||
      phases.llm === "running";

    const handleScroll = () => {
      setShowBackToTop(activeRun && window.scrollY > 200);
    };

    if (activeRun) {
      window.addEventListener("scroll", handleScroll, { passive: true } as AddEventListenerOptions);
      handleScroll();
    } else {
      setShowBackToTop(false);
    }

    return () => window.removeEventListener("scroll", handleScroll);
  }, [isSearchInProgress, isAnalyzing, phases.profile, phases.heuristic, phases.llm]);

  const handleSearch = async () => {
    const raw = queryInput.trim();
    if (!raw) return;
    if (searchStreamRef.current) stopSearch({ keepPhase: true });
    const isEmail = raw.includes("@");
    const handle = isEmail ? raw.split("@")[0] : raw;
    setUsername(handle);
    setEmail(isEmail ? raw : "");
    setHeuristicResult(null);
    setLlmResult(null);
    setAnalysisError(null);
    setFoundDetails([]);
    setProfileReady(false);
    updatePhase({ availability: "running", profile: "idle", heuristic: "idle", llm: "idle" });

    setIsChecking(true);
    setResults(buildInitialResults(handle));

    const url = `${API_BASE}/api/search/username/stream?username=${encodeURIComponent(handle)}`;
    const handleSiteResult = (ev: MessageEvent) => {
      try {
        const payload = JSON.parse(ev.data);
        if (!payload?.result) return;
        const r = payload.result;
        upsertResult({
          platform: r.site,
          url: r.url,
          status: r.found ? "found" : (r.state as ResultStatus) || "unknown",
          statusCode: r.status_code || 0,
          checking: false,
          viaProxy: r.via_proxy,
          latencyMs: r.latency_ms,
          reason: r.reason,
          displayName: r.display_name,
          bio: r.bio,
          avatar: r.avatar,
        });
      } catch (e) {
        console.error("site_result parse error", e);
      }
    };

    const handleComplete = (ev: MessageEvent) => {
      try {
        const payload = JSON.parse(ev.data);
        if (!payload?.summary) return;
        const found = (payload.found_profiles || []).map((r: any) => ({
          platform: r.site,
          url: r.url,
          status: "found" as ResultStatus,
          statusCode: r.status_code || 0,
          checking: false,
          viaProxy: r.via_proxy,
          latencyMs: r.latency_ms,
          reason: r.reason,
          displayName: r.display_name,
          bio: r.bio,
          avatar: r.avatar,
        }));
        setFoundDetails(found);
        updatePhase({ availability: "done", profile: found.length ? "ready" : "idle" });
      } catch (e) {
        console.error("search_complete parse error", e);
      } finally {
        stopSearch({ keepPhase: true });
      }
    };

    const es = new EventSource(url);
    searchStreamRef.current = es;
    es.addEventListener("site_result", handleSiteResult);
    es.addEventListener("search_complete", handleComplete);
    es.onmessage = handleSiteResult; // fallback if server sends default event

    es.onerror = () => {
      stopSearch();
    };
  };

  const deepProfiles: DeepProfileResult[] = useMemo(() => {
    const source = foundDetails.length ? foundDetails : foundFromResults;
    if (!source.length || !profileReady) return [];
    const byKey = new Map<string, DeepProfileResult>();
    source.forEach((p) => {
      const key = `${p.platform}__${p.url || ""}`;
      if (byKey.has(key)) return;
      byKey.set(key, {
        platform: p.platform,
        url: p.url,
        displayName: p.displayName || `${username} • ${p.platform}`,
        bio: p.bio || "Public profile detected (metadata parsed).",
        avatar: normalizeAvatar(p.avatar, username, p.platform),
        category: getCategoryForPlatform(p.platform),
      });
    });
    return Array.from(byKey.values());
  }, [foundDetails, foundFromResults, profileReady, username]);

  const extractEmails = (text: string | null | undefined) => {
    if (!text) return [] as string[];
    const matches = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
    return matches ? Array.from(new Set(matches.map((m) => m.toLowerCase()))) : [];
  };

  const mindMapData = useMemo(() => {
    const profilesForMap = (deepProfiles.length ? deepProfiles : foundFromResults).map((p) => ({
      id: p.platform,
      label: p.displayName || p.platform,
      url: p.url || getPlatformUrl(p.platform, username || ""),
      category: p.category || getCategoryForPlatform(p.platform),
      displayName: p.displayName,
      bio: (p as any).bio || "",
      emails: extractEmails(p.bio).concat(extractEmails(p.displayName)),
      avatar: normalizeAvatar((p as any).avatar, username, p.platform),
    }));

    const rootLabel = (username || email || "root").trim() || "root";
    const root = { id: "root", label: rootLabel, kind: "root" as const };

    type Leg = { id: string; label: string; source: string; reason: string; kind: "identity" | "category" | "unlinked" };

    const legs: Leg[] = [];
    const legProfilesMap: Record<string, typeof profilesForMap> = {};

    const profileKey = (p: typeof profilesForMap[number]) => `${p.platform}__${p.url || ""}`;
    const dedupeList = (list: typeof profilesForMap) => {
      const seen = new Set<string>();
      const unique: typeof profilesForMap = [];
      list.forEach((p) => {
        const key = profileKey(p);
        if (seen.has(key)) return;
        seen.add(key);
        unique.push(p);
      });
      return unique;
    };

    const ensureLeg = (id: string, label: string, source: string, kind: Leg["kind"], reason: string) => {
      if (legs.find((l) => l.id === id)) return;
      legs.push({ id, label, source, kind, reason });
      legProfilesMap[id] = [];
    };

    const assignProfileToLeg = (profile: typeof profilesForMap[number], legId: string) => {
      legProfilesMap[legId] = legProfilesMap[legId] || [];
      const key = profileKey(profile);
      const exists = (legProfilesMap[legId] || []).some((p) => profileKey(p) === key);
      if (!exists) legProfilesMap[legId].push(profile);
    };

    ensureLeg("leg-unlinked", "Unlinked", "unlinked", "unlinked", "No clear linkage; left unmatched.");

    if (branchMode === "all") {
      const trimmedUsername = username.trim();
      if (trimmedUsername) {
        ensureLeg("leg-username", trimmedUsername, "username", "identity", `Matched username “${trimmedUsername}” in profile data.`);
      }

      const emailSet = new Set<string>();
      profilesForMap.forEach((p) => p.emails.forEach((em) => emailSet.add(em.toLowerCase())));
      Array.from(emailSet).forEach((em, idx) => ensureLeg(`leg-email-${idx}`, em, "email", "identity", `Matched email “${em}”.`));

      const nameCounts = new Map<string, number>();
      profilesForMap.forEach((p) => {
        const clean = (p.displayName || "").trim().toLowerCase();
        if (!clean) return;
        nameCounts.set(clean, (nameCounts.get(clean) || 0) + 1);
      });
      Array.from(nameCounts.entries()).forEach(([name, count], idx) => {
        if (count > 1) ensureLeg(`leg-display-${idx}`, name, "profile", "identity", `Matched reused display name “${name}” (${count} hits).`);
      });

      profilesForMap.forEach((p) => {
        const lowerName = (p.displayName || "").toLowerCase();
        const lowerBio = (p.bio || "").toLowerCase();
        const lowerUrl = (p.url || "").toLowerCase();
        let target: string | null = null;

        if (trimmedUsername) {
          const uname = trimmedUsername.toLowerCase();
          const hit = lowerName.includes(uname) || lowerBio.includes(uname) || lowerUrl.includes(uname);
          if (hit) target = legs.find((l) => l.source === "username")?.id || null;
        }

        if (!target) {
          const hitEmailLeg = legs.find((l) => l.source === "email" && p.emails.some((em) => em.toLowerCase() === l.label.toLowerCase()));
          if (hitEmailLeg) target = hitEmailLeg.id;
        }

        if (!target) {
          const hitNameLeg = legs.find((l) => l.source === "profile" && l.label === lowerName);
          if (hitNameLeg) target = hitNameLeg.id;
        }

        assignProfileToLeg(p, target || "leg-unlinked");
      });
    } else {
      const categories = new Map<string, typeof profilesForMap>();
      profilesForMap.forEach((p) => {
        const cat = p.category || "Uncategorized";
        if (!categories.has(cat)) categories.set(cat, []);
        categories.get(cat)!.push(p);
      });

      Array.from(categories.entries()).forEach(([cat, items], idx) => {
        const legId = `leg-cat-${idx}`;
        ensureLeg(legId, cat, "category", "category", `Category “${cat}” based on site catalog.`);
        dedupeList(items).forEach((profile) => assignProfileToLeg(profile, legId));
      });
    }

    const profileNodes = profilesForMap.map((p) => ({ ...p, kind: "profile" as const }));

    return { root, legs, profiles: profileNodes, legProfilesMap };
  }, [deepProfiles, foundFromResults, username, email, connectBy, branchMode]);

  useEffect(() => {
    setMapPan({ x: 0, y: 0 });
    setMapZoom(1);
  }, [mindMapData.legs.length, mindMapData.profiles.length]);

  const identityProfilesMap = useMemo(() => {
    // For backward compatibility of naming; now maps legId -> profiles
    return mindMapData.legProfilesMap;
  }, [mindMapData]);

  const buildProfiles = () => {
    const source = foundDetails.length ? foundDetails : foundFromResults;
    if (!source.length) return;
    if (!foundDetails.length) setFoundDetails(source);
    setProfileReady(true);
    setHeuristicResult(null);
    setLlmResult(null);
    setAnalysisError(null);
    updatePhase({ profile: "done", heuristic: "ready", llm: useLLM ? "ready" : "idle" });
    requestAnimationFrame(() => {
      scrollAndFocus(deepSectionRef);
    });
  };

  const runHeuristic = async () => {
    if (!deepProfiles.length || isAnalyzing) return;
    setIsAnalyzing(true);
    setAnalysisError(null);
    setHeuristicResult(null);
    setLlmResult(null); // clear downstream so re-runs don't show stale LLM output
    updatePhase({ heuristic: "running", llm: useLLM ? "ready" : "idle" });
    try {
      const res = await fetch(`${API_BASE}/api/profile/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profiles: deepProfiles.map((p) => ({
            platform: p.platform,
            url: p.url,
            display_name: p.displayName,
            bio: p.bio,
            avatar: p.avatar,
            category: p.category,
          })),
          use_llm: false,
          username: username || undefined,
          email: email || undefined,
          prompt: analyzerPrompt || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || data?.error || "Heuristic analysis failed");
      setHeuristicResult({
        summary: data.summary || "",
        traits: data.traits || [],
        risks: data.risks || [],
        mode: data.mode || "heuristic",
        llm_used: data.llm_used,
        llm_model: data.llm_model,
        llm_error: data.llm_error,
      });
      setLlmResult(null);
      updatePhase({ heuristic: "done", llm: useLLM ? "ready" : "idle" });
      requestAnimationFrame(() => {
        scrollAndFocus(analyzerSectionRef);
      });
    } catch (e) {
      setAnalysisError((e as Error).message);
      setHeuristicResult(null);
      updatePhase({ heuristic: "idle" });
    } finally {
      setIsAnalyzing(false);
    }
  };

  const runLlm = async () => {
    if (!deepProfiles.length || !useLLM || isAnalyzing) return;
    setIsAnalyzing(true);
    setAnalysisError(null);
    setLlmResult(null); // clear prior LLM run when re-triggered
    updatePhase({ llm: "running" });
    try {
      const res = await fetch(`${API_BASE}/api/profile/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profiles: deepProfiles.map((p) => ({
            platform: p.platform,
            url: p.url,
            display_name: p.displayName,
            bio: p.bio,
            avatar: p.avatar,
            category: p.category,
          })),
          use_llm: true,
          llm_model: llmModel,
          ollama_host: ollamaHost,
          api_mode: llmApiMode,
          username: username || undefined,
          email: email || undefined,
          prompt: analyzerPrompt || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail || data?.error || "LLM analysis failed");
      setLlmResult({
        summary: data.summary || "",
        traits: data.traits || [],
        risks: data.risks || [],
        mode: data.mode || "llm",
        llm_used: data.llm_used,
        llm_model: data.llm_model,
        llm_error: data.llm_error,
      });
      updatePhase({ llm: "done" });
      requestAnimationFrame(() => {
        scrollAndFocus(exportSectionRef);
      });
    } catch (e) {
      setAnalysisError((e as Error).message);
      updatePhase({ llm: "ready" });
    } finally {
      setIsAnalyzing(false);
    }
  };

  const runHeuristicAndLlm = async () => {
    if (!deepProfiles.length || !useLLM || isAnalyzing) return;
    setIsAnalyzing(true);
    setAnalysisError(null);
    setHeuristicResult(null);
    setLlmResult(null);
    updatePhase({ heuristic: "running", llm: "running" });

    const payloadBase = deepProfiles.map((p) => ({
      platform: p.platform,
      url: p.url,
      display_name: p.displayName,
      bio: p.bio,
      avatar: p.avatar,
      category: p.category,
    }));

    try {
      const heuristicRes = await fetch(`${API_BASE}/api/profile/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profiles: payloadBase,
          use_llm: false,
          username: username || undefined,
          email: email || undefined,
          prompt: analyzerPrompt || undefined,
        }),
      });

      const heuristicData = await heuristicRes.json();
      if (!heuristicRes.ok) throw new Error(heuristicData?.detail || heuristicData?.error || "Heuristic analysis failed");

      setHeuristicResult({
        summary: heuristicData.summary || "",
        traits: heuristicData.traits || [],
        risks: heuristicData.risks || [],
        mode: heuristicData.mode || "heuristic",
        llm_used: heuristicData.llm_used,
        llm_model: heuristicData.llm_model,
        llm_error: heuristicData.llm_error,
      });

      updatePhase({ heuristic: "done", llm: "running" });

      const llmRes = await fetch(`${API_BASE}/api/profile/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profiles: payloadBase,
          use_llm: true,
          llm_model: llmModel,
          ollama_host: ollamaHost,
          api_mode: llmApiMode,
          username: username || undefined,
          email: email || undefined,
          prompt: analyzerPrompt || undefined,
        }),
      });

      const llmData = await llmRes.json();
      if (!llmRes.ok) throw new Error(llmData?.detail || llmData?.error || "LLM analysis failed");

      setLlmResult({
        summary: llmData.summary || "",
        traits: llmData.traits || [],
        risks: llmData.risks || [],
        mode: llmData.mode || "llm",
        llm_used: llmData.llm_used,
        llm_model: llmData.llm_model,
        llm_error: llmData.llm_error,
      });

      updatePhase({ llm: "done" });
      requestAnimationFrame(() => {
        scrollAndFocus(exportSectionRef);
      });
    } catch (e) {
      setAnalysisError((e as Error).message);
      updatePhase({ heuristic: "idle", llm: "ready" });
    } finally {
      setIsAnalyzing(false);
    }
  };

  const exportJson = () => {
    setExporting(true);
    const payload = {
      username,
      email,
      exported_at: new Date().toISOString(),
      availability: results,
      profiles: deepProfiles,
      analysis: {
        heuristic: heuristicResult,
        llm: llmResult,
      },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `deepkrak3n_${username || "export"}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setExporting(false);
  };

  const exportHtml = () => {
    setExportingHtml(true);
    const prettyDate = new Date().toLocaleString();
    const analysis = displayedAnalysis;
    const html = `<!doctype html><html><head><meta charset="utf-8" /><title>deepkrak3n report</title>
      <style>
        body{font-family:Segoe UI,Arial,sans-serif;background:#0f172a;color:#e5e7eb;padding:24px;}
        h1,h2,h3{color:#a5b4fc;margin-bottom:8px;}
        .card{border:1px solid #1f2937;background:#111827;border-radius:12px;padding:16px;margin-bottom:16px;}
        .badge{display:inline-block;padding:4px 8px;border-radius:8px;font-size:12px;border:1px solid #334155;margin-right:6px;margin-top:4px;}
        .found{background:#064e3b;border-color:#10b981;color:#d1fae5;}
        .notfound{background:#7f1d1d;border-color:#f87171;color:#fecdd3;}
        table{width:100%;border-collapse:collapse;margin-top:8px;}
        th,td{border:1px solid #1f2937;padding:6px;text-align:left;font-size:13px;}
        th{background:#111827;color:#cbd5e1;}
        a{color:#38bdf8;}
      </style></head><body>
      <h1>deepkrak3n export</h1>
      <div class="card"><strong>Username:</strong> ${username || "-"}<br/><strong>Email:</strong> ${email || "-"}<br/><strong>Exported:</strong> ${prettyDate}</div>
      <div class="card"><h2>Availability (${results.length} checks)</h2>
        <table><thead><tr><th>Platform</th><th>Status</th><th>Link</th><th>Reason</th></tr></thead><tbody>
          ${results
            .map((r) => `<tr><td>${r.platform}</td><td>${statusLabel(r.status, r.checking)}</td><td>${r.url ? `<a href="${r.url}">${r.url}</a>` : ""}</td><td>${r.reason || ""}</td></tr>`)
            .join("")}
        </tbody></table>
      </div>
      <div class="card"><h2>Profiles (${deepProfiles.length})</h2>
        ${deepProfiles
          .map(
            (p) => `<div style="margin-bottom:8px;"><strong>${p.platform}</strong> — <a href="${p.url}">${p.url}</a><br/>${p.displayName || ""}<br/><span style="font-size:12px;color:#cbd5e1;">${p.bio || ""}</span></div>`
          )
          .join("")}
      </div>
      <div class="card"><h2>Analysis</h2>
        ${analysis ? `<div>${analysis.summary || ""}</div>` : "<div>No analysis run.</div>"}
        ${analysis?.traits?.length ? `<div style="margin-top:6px;">Traits: ${analysis.traits.map((t) => `<span class='badge'>${t}</span>`).join(" ")}</div>` : ""}
        ${analysis?.risks?.length ? `<div style="margin-top:6px;">Risks: ${analysis.risks.map((t) => `<span class='badge notfound'>${t}</span>`).join(" ")}</div>` : ""}
      </div>
      </body></html>`;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `deepkrak3n_${username || "report"}.html`;
    a.click();
    URL.revokeObjectURL(url);
    setExportingHtml(false);
  };

  const previewExport = () => {
    const prettyDate = new Date().toLocaleString();
    const analysis = displayedAnalysis;
    const rows = results
      .map(
        (r) =>
          `<tr><td>${r.platform}</td><td>${statusLabel(r.status, r.checking)}</td><td>${r.url ? `<a href="${r.url}" target="_blank">link</a>` : ""}</td><td>${r.reason || ""}</td></tr>`
      )
      .join("");
    const profilesHtml = deepProfiles
      .map(
        (p) => `<div style="margin-bottom:10px"><strong>${p.platform}</strong> — <a href="${p.url}" target="_blank">${p.url}</a><br/>${p.displayName || ""}<br/><span style="font-size:12px;color:#cbd5e1;">${p.bio || ""}</span></div>`
      )
      .join("");
    const analysisHtml = analysis
      ? `<div>${analysis.summary || ""}</div>` +
        (analysis.traits?.length ? `<div style="margin-top:6px;">Traits: ${analysis.traits.map((t) => `<span class='badge'>${t}</span>`).join(" ")}</div>` : "") +
        (analysis.risks?.length ? `<div style="margin-top:6px;">Risks: ${analysis.risks.map((t) => `<span class='badge notfound'>${t}</span>`).join(" ")}</div>` : "")
      : "<div>No analysis run.</div>";
    const html = `<!doctype html><html><head><meta charset="utf-8" /><style>
      body{font-family:Segoe UI,Arial,sans-serif;background:#0f172a;color:#e5e7eb;padding:24px;}
      h1,h2,h3{color:#a5b4fc;margin-bottom:8px;}
      .card{border:1px solid #1f2937;background:#111827;border-radius:12px;padding:16px;margin-bottom:16px;}
      .badge{display:inline-block;padding:4px 8px;border-radius:8px;font-size:12px;border:1px solid #334155;margin-right:6px;margin-top:4px;}
      .notfound{background:#7f1d1d;border-color:#f87171;color:#fecdd3;}
      table{width:100%;border-collapse:collapse;margin-top:8px;}
      th,td{border:1px solid #1f2937;padding:6px;text-align:left;font-size:13px;}
      th{background:#111827;color:#cbd5e1;}
      a{color:#38bdf8;}
    </style></head><body>
      <h1>deepkrak3n export preview</h1>
      <div class="card"><strong>Username:</strong> ${username || "-"}<br/><strong>Email:</strong> ${email || "-"}<br/><strong>Generated:</strong> ${prettyDate}</div>
      <div class="card"><h2>Availability (${results.length})</h2><table><thead><tr><th>Platform</th><th>Status</th><th>Link</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="card"><h2>Profiles (${deepProfiles.length})</h2>${profilesHtml || "<div>None</div>"}</div>
      <div class="card"><h2>Analysis</h2>${analysisHtml}</div>
    </body></html>`;
    setPreviewHtml(html);
    setShowPreview(true);
  };

  function getCategoryForPlatform(platform: string) {
    for (const [cat, list] of Object.entries(platformCategories)) {
      if (list.includes(platform)) return cat;
    }
    return "Other";
  }

  const toggleCategory = (category: string) => {
    setExpandedCategories((prev) => ({ ...prev, [category]: !prev[category] }));
  };

  const getResultsForCategory = (platforms: string[]) =>
    results.filter((r) => platforms.includes(r.platform));

  const scrollToSection = (ref: React.RefObject<HTMLDivElement | null>) => {
    ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const scrollAndFocus = (ref: React.RefObject<HTMLElement | null>) => {
    if (!ref.current) return;
    if (ref.current) {
      const yOffset = -15;
      const elementTop = ref.current.getBoundingClientRect().top + window.scrollY + yOffset;
      window.scrollTo({ top: elementTop, behavior: "smooth" });
      ref.current.focus({ preventScroll: true });
    }
  };

  const formatSummary = (text: string | undefined | null) => {
    if (!text) return "";
    return text.replace(/\*\*/g, "").trim();
  };

  const openProfileModal = (p: DeepProfileResult) => {
    setActiveProfile(p);
  };

  const closeProfileModal = () => {
    setActiveProfile(null);
    setActiveBranch(null);
  };

  return (
    <div className="min-h-screen text-white px-4 pt-12 pb-0 flex flex-col" style={{ backgroundColor: palette.bg, position: "relative" }}>
      <div className="bubble-layer" aria-hidden="true">
        <div className="bubble bubble--1" />
        <div className="bubble bubble--2" />
        <div className="bubble bubble--3" />
        <div className="bubble bubble--4" />
        <div className="bubble bubble--5" />
        <div className="bubble bubble--6" />
        <div className="bubble bubble--7" />
        <div className="bubble bubble--8" />
        <div className="bubble bubble--9" />
        <div className="bubble bubble--10" />
        <div className="bubble bubble--11" />
        <div className="bubble bubble--12" />
      </div>
      <div className="flex-1" style={{ position: "relative", zIndex: 1 }}>
      <motion.div
        className="max-w-5xl mx-auto mb-10 pt-4"
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <div className="flex items-center gap-3 mb-3">
          <div className="glitch-logo">
            <Image src={logo} alt="deepkrak3n logo" className="rounded-md" style={{ width: 77, height: 77 }} priority />
          </div>
          <div>
            <div className="stack-title" style={{ color: palette.light }}>
              <div className="stack" style={{ ["--stacks" as any]: 3 }}>
                <span style={{ ["--index" as any]: 0 }}>deepkrak3n</span>
                <span style={{ ["--index" as any]: 1 }}>deepkrak3n</span>
                <span style={{ ["--index" as any]: 2 }}>deepkraken</span>
              </div>
              <span className="stack-sub">OSINT Profile Search and Analysis</span>
            </div>
          </div>
          <button
            onClick={() => setSettingsOpen(true)}
            className="ml-auto inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm"
            style={{ backgroundColor: palette.panel, border: `1px solid ${palette.border}` }}
          >
            <Settings className="w-4 h-4" aria-label="Settings" />
          </button>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 mb-4">
          <input
            type="text"
            placeholder="username or email"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
            className="flex-1 px-4 py-3 rounded-lg focus:outline-none"
            style={{ backgroundColor: palette.panel, border: `1px solid ${palette.border}`, color: palette.light }}
          />
          <button
            onClick={isChecking ? () => stopSearch() : handleSearch}
            disabled={!queryInput.trim() && !isChecking}
            className="px-4 py-3 rounded-lg font-semibold disabled:cursor-not-allowed"
            style={{
              backgroundColor: isChecking ? "#b91c1c" : palette.accentDark,
              border: `1px solid ${isChecking ? "#7f1d1d" : palette.border}`,
              color: palette.light,
              opacity: !queryInput.trim() && !isChecking ? 0.5 : 1,
            }}
          >
            {isChecking ? "Stop" : "Search"}
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 text-sm">
          <div className="p-3 rounded-lg border" style={{ backgroundColor: palette.panelDark, borderColor: palette.border }}>
            <div style={{ color: palette.light }}>Phase 1</div>
            <div className="font-semibold">Availability</div>
            <div className={`text-xs ${phaseTextClass(phases.availability)}`}>{phases.availability}</div>
          </div>
          <div className="p-3 rounded-lg border" style={{ backgroundColor: palette.panelDark, borderColor: palette.border }}>
            <div style={{ color: palette.light }}>Phase 2</div>
            <div className="font-semibold">Profile Check</div>
            <div className={`text-xs ${phaseTextClass(phases.profile)}`}>{phases.profile}</div>
          </div>
          <div className="p-3 rounded-lg border" style={{ backgroundColor: palette.panelDark, borderColor: palette.border }}>
            <div style={{ color: palette.light }}>Phase 3</div>
            <div className="font-semibold">Deep Analysis</div>
            <div className={`text-xs ${phaseTextClass(phases.heuristic)}`}>{phases.heuristic}</div>
          </div>
          <div className="p-3 rounded-lg border" style={{ backgroundColor: palette.panelDark, borderColor: palette.border }}>
            <div style={{ color: palette.light }}>Phase 4</div>
            <div className="font-semibold">LLM Analyser</div>
            <div className={`text-xs ${phaseTextClass(phases.llm)}`}>{phases.llm}</div>
          </div>
          <div className="p-3 rounded-lg border" style={{ backgroundColor: palette.panelDark, borderColor: palette.border }}>
            <div style={{ color: palette.light }}>Phase 5</div>
            <div className="font-semibold">Export</div>
            <div className="text-xs" style={{ color: palette.light }}>
              JSON / HTML
            </div>
          </div>
        </div>
      </motion.div>

      <div className="max-w-5xl mx-auto space-y-8" ref={availabilitySectionRef} tabIndex={-1}>
        {(isChecking || results.length > 0) && (
          <section className="space-y-4 rounded-xl border" style={{ borderColor: palette.border }}>
            <div className="flex items-center justify-between py-3" style={{ minHeight: 88, paddingRight: 15 }}>
              <button
                onClick={() => setAvailabilityCollapsed((v) => !v)}
                className="text-left"
                aria-expanded={!availabilityCollapsed}
              >
                <div className="flex items-center gap-3">
                  <ChevronDown className={`w-5 h-5 transition-transform ${availabilityCollapsed ? "-rotate-90" : "rotate-0"}`} />
                  <div>
                    <h2 className="text-xl font-semibold">Availability</h2>
                    <div className="flex items-center gap-2 text-sm" style={{ color: palette.light }}>
                      <span>{isChecking ? "Streaming results..." : results.length ? `${results.filter((r) => r.status === "found").length} found / ${results.length}` : "Idle"}</span>
                      {results.length > 0 && (
                        <span className="px-2 py-1 rounded-full text-xs" style={{ backgroundColor: palette.panelDark, border: `1px solid ${palette.border}` }}>
                          {results.filter((r) => r.status === "found").length}/{results.length}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </button>
              <div className="flex items-center gap-2 text-sm" style={{ color: palette.light }}>
                <button
                  onClick={() => {
                    if (!profileReady) buildProfiles();
                    scrollAndFocus(deepSectionRef);
                  }}
                  disabled={(!foundDetails.length && !foundFromResults.length) || hasInFlightResults}
                  className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap disabled:cursor-not-allowed"
                  style={{
                    ...phaseButtonStyle(!((!foundDetails.length && !foundFromResults.length) || hasInFlightResults), phases.availability === "done"),
                    width: 240,
                    height: 42,
                  }}
                >
                  <Play className="w-4 h-4" /> Next phase → Profile check
                </button>
              </div>
            </div>
            {!availabilityCollapsed && (
              <div className="space-y-3 border rounded-lg" style={{ backgroundColor: palette.panel, borderColor: palette.border }}>
                <div className="px-4 pb-4 space-y-3" style={{ minHeight: 220, paddingTop: 17 }}>
                  {Object.entries(platformCategories).map(([category, platforms]) => {
                    const categoryResults = getResultsForCategory(platforms);
                    if (!categoryResults.length) return null;
                    const expanded = expandedCategories[category];
                    return (
                      <div key={category} className="border rounded-lg" style={{ backgroundColor: palette.panel, borderColor: palette.border }}>
                        <button
                          onClick={() => toggleCategory(category)}
                          className="w-full px-4 py-3 flex items-center justify-between"
                          style={{ backgroundColor: expanded ? "rgba(96,81,155,0.15)" : palette.panel }}
                        >
                          <div className="flex items-center gap-2">
                            <ChevronDown className={`w-4 h-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
                            <span className="font-semibold">{category}</span>
                          </div>
                          <span className="text-sm" style={{ color: palette.light }}>
                            {categoryResults.filter((r) => r.status === "found").length}/{categoryResults.length} found
                          </span>
                        </button>
                        {expanded && (
                          <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" style={{ borderTop: `1px solid ${palette.border}` }}>
                            {categoryResults.map((r) => (
                              <div
                                key={r.platform}
                                className={`rounded-lg border ${statusClasses(r.status, r.checking)} px-3 py-2 flex items-center justify-between`}
                              >
                                <div>
                                  <div className="font-medium">{r.platform}</div>
                                  {r.reason && <div className="text-xs text-gray-300">{r.reason}</div>}
                                  {r.viaProxy && <div className="text-[11px]" style={{ color: palette.light }}>via proxy</div>}
                                </div>
                                <div className="flex items-center gap-2">
                                  {r.status === "found" && (
                                    <a
                                      href={r.url || getPlatformUrl(r.platform, username) || "#"}
                                      className="text-lg"
                                      target="_blank"
                                      rel="noreferrer"
                                      aria-label={`Open ${r.platform}`}
                                    >
                                      🔗
                                    </a>
                                  )}
                                  <span className="text-xs font-semibold px-2 py-1 rounded-full border" style={{ borderColor: palette.border }}>
                                    {statusLabel(r.status, r.checking)}
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        )}

        {profileReady && (
          <section ref={deepSectionRef} className="space-y-3 rounded-xl border" tabIndex={-1} style={{ borderColor: palette.border }}>
          <div className="flex items-center justify-between py-3" style={{ minHeight: 88, paddingRight: 15 }}>
            <button
              onClick={() => setProfileCheckCollapsed((v) => !v)}
              className="flex items-center gap-2 text-left"
              aria-expanded={!profileCheckCollapsed}
            >
              <ChevronDown className={`w-5 h-5 transition-transform ${profileCheckCollapsed ? "-rotate-90" : "rotate-0"}`} />
              <h2 className="text-xl font-semibold">Profile check</h2>
            </button>
            <button
              onClick={() => {
                if (!deepProfiles.length) return;
                setDeepAnalysisCollapsed(false);
                scrollAndFocus(deepAnalysisSectionRef);
              }}
              disabled={!deepProfiles.length || isAnalyzing}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap disabled:cursor-not-allowed"
              style={{
                ...phaseButtonStyle(!( !deepProfiles.length || isAnalyzing ), phases.profile === "ready" || phases.profile === "done"),
                width: 240,
                height: 42,
              }}
            >
              <Play className="w-4 h-4" /> Next phase → Deep analysis
            </button>
          </div>

          {!profileCheckCollapsed && deepProfiles.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4" style={{ paddingTop: 12 }}>
              {deepProfiles.map((p) => (
                <div key={p.platform} className="p-4 rounded-lg border" style={{ backgroundColor: palette.panel, borderColor: palette.border }}>
                  <div className="flex items-center gap-3">
                    <img src={p.avatar} alt={`${p.platform} avatar`} className="w-12 h-12 rounded-full" style={{ backgroundColor: palette.bg }} />
                    <div>
                      <a href={p.url} className="font-semibold hover:underline" target="_blank" rel="noreferrer" style={{ color: palette.light }}>
                        {p.displayName}
                      </a>
                      <div className="text-sm" style={{ color: palette.light }}>
                        {p.platform}
                      </div>
                    </div>
                    <button
                      onClick={() => openProfileModal(p)}
                      className="ml-auto text-xs px-2 py-1 rounded-md"
                      style={{ backgroundColor: palette.panel, border: `1px solid ${palette.border}`, color: palette.light }}
                    >
                      View
                    </button>
                  </div>
                  <div className="text-sm mt-2 whitespace-pre-wrap" style={{ color: palette.light }}>{p.bio}</div>
                </div>
              ))}
            </div>
          )}
        </section>
        )}

        {deepProfiles.length > 0 && (
          <section className="space-y-3 rounded-xl border" tabIndex={-1} ref={deepAnalysisSectionRef} style={{ borderColor: palette.border }}>
          <div className="flex items-center justify-between py-3" style={{ minHeight: 88, paddingRight: 15 }}>
            <button
              onClick={() => setDeepAnalysisCollapsed((v) => !v)}
              className="flex items-center gap-2 text-left"
              aria-expanded={!deepAnalysisCollapsed}
            >
              <ChevronDown className={`w-5 h-5 transition-transform ${deepAnalysisCollapsed ? "-rotate-90" : "rotate-0"}`} />
              <h2 className="text-xl font-semibold">Deep Analysis</h2>
            </button>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setLlmCollapsed(false);
                  scrollAndFocus(analyzerSectionRef);
                  if (isAnalyzing || !deepProfiles.length || !useLLM) return;
                  runHeuristicAndLlm();
                }}
                disabled={isAnalyzing || !deepProfiles.length || !useLLM}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap disabled:cursor-not-allowed"
                style={{
                  ...phaseButtonStyle(!(isAnalyzing || !deepProfiles.length || !useLLM), phases.llm === "ready" || phases.heuristic === "done"),
                  width: 240,
                  height: 42,
                }}
              >
                <Play className="w-4 h-4" /> {isAnalyzing ? "Running heuristic + LLM..." : "Next phase → LLM analyser"}
              </button>
            </div>
          </div>
          {!deepAnalysisCollapsed && (
          <>
          {mindMapData.profiles.length > 0 && (() => {
            const legs = mindMapData.legs.filter((leg) => (identityProfilesMap[leg.id] || []).length > 0);
            const profileNodes = mindMapData.profiles;

            const ringGap = 140;
            const baseRadius = 180;
            const svgWidth = 1400;
            const svgHeight = 980;
            const center = { x: svgWidth / 2, y: svgHeight / 2 };

            const angleStep = legs.length ? (Math.PI * 2) / legs.length : Math.PI * 2;

            const legPositions = legs.map((leg, idx) => {
              const angle = -Math.PI / 2 + idx * angleStep;
              const cx = center.x + baseRadius * Math.cos(angle);
              const cy = center.y + baseRadius * Math.sin(angle);
              return { ...leg, angle, cx, cy };
            });

            const profilePositions = legPositions.flatMap((leg) => {
              const profiles = (identityProfilesMap[leg.id] || []).slice().sort((a, b) => likelihoodScore(b) - likelihoodScore(a));
              return profiles.map((p, idx) => {
                const radius = baseRadius + (idx + 1) * ringGap;
                const x = center.x + radius * Math.cos(leg.angle);
                const y = center.y + radius * Math.sin(leg.angle);
                return { ...p, x, y, legId: leg.id, legReason: leg.reason, legLabel: leg.label, legSource: leg.source };
              });
            });

            const describeBranchBasis = (leg: any) => {
              if (!leg) return { type: "unknown", value: "", note: "" };
              if (leg.kind === "category") return { type: "category", value: leg.label, note: leg.reason };
              if (leg.source === "username") return { type: "username", value: leg.label, note: leg.reason };
              if (leg.source === "email") return { type: "email", value: leg.label, note: leg.reason };
              if (leg.source === "profile") return { type: "display name", value: leg.label, note: leg.reason };
              return { type: "unlinked", value: leg.label, note: leg.reason };
            };

            return (
              <div className="p-4 rounded-lg border space-y-3" style={{ backgroundColor: palette.panel, borderColor: palette.border }}>
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div className="text-sm" style={{ color: palette.light }}>
                    Mind map: central handle with radial legs. View All = detected links; By category = availability categories.
                  </div>
                  <div className="flex items-center gap-3 text-xs" style={{ color: palette.light }}>
                    <span>
                      {profileNodes.length} profiles • {legs.length} legs
                    </span>
                    <span className="flex items-center gap-2">
                      Zoom
                      <input
                        type="range"
                        min="0.7"
                        max="3"
                        step="0.1"
                        value={mapZoom}
                        onChange={(e) => setMapZoom(parseFloat(e.target.value))}
                        className="accent-slate-300"
                      />
                    </span>
                    <label className="flex items-center gap-1">
                      <input type="checkbox" checked={showConnections} onChange={(e) => setShowConnections(e.target.checked)} className="accent-slate-300" />
                      <span>Show connections</span>
                    </label>
                    <div className="flex items-center gap-2">
                      <span>Connect by</span>
                      {([
                        { value: "username", label: "username" },
                        { value: "email", label: "email" },
                        { value: "profile", label: "profile" },
                      ] as const).map((opt) => (
                        <label key={opt.value} className="flex items-center gap-1">
                          <input
                            type="radio"
                            name="connectBy"
                            value={opt.value}
                            checked={connectBy === opt.value}
                            onChange={() => setConnectBy(opt.value)}
                            className="accent-slate-300"
                          />
                          <span>{opt.label}</span>
                        </label>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <span>View</span>
                      {([
                        { value: "all", label: "View All" },
                        { value: "category", label: "By category" },
                      ] as const).map((opt) => (
                        <label key={opt.value} className="flex items-center gap-1">
                          <input
                            type="radio"
                            name="branchMode"
                            value={opt.value}
                            checked={branchMode === opt.value}
                            onChange={() => setBranchMode(opt.value)}
                            className="accent-slate-300"
                          />
                          <span>{opt.label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="relative overflow-hidden rounded-lg border" style={{ backgroundColor: palette.panelDark, borderColor: palette.border }}>
                  <svg
                    viewBox={`0 0 ${svgWidth} ${svgHeight}`}
                    className="w-full"
                    style={{ height: "70vh", minHeight: "620px", maxHeight: "900px", userSelect: "none", cursor: isPanning ? "grabbing" : "grab" }}
                    onMouseDown={handleMapMouseDown}
                    onMouseMove={handleMapMouseMove}
                    onMouseUp={handleMapMouseUp}
                    onMouseLeave={handleMapMouseUp}
                    onDoubleClick={handleMapDoubleClick}
                  >
                    <g transform={`translate(${mapPan.x} ${mapPan.y}) scale(${mapZoom})`}>
                      {/* root */}
                      <circle cx={center.x} cy={center.y} r={26} fill={palette.accentDark} stroke={palette.border} strokeWidth={2} />
                      <text x={center.x} y={center.y + 40} textAnchor="middle" fontSize={14} fill={palette.light}>
                        {mindMapData.root.label}
                      </text>

                      {/* legs */}
                      {legPositions.map((leg) => (
                        <g key={leg.id}>
                          {showConnections && (
                            <line x1={center.x} y1={center.y} x2={leg.cx} y2={leg.cy} stroke={palette.border} strokeWidth={2} strokeOpacity={0.9} />
                          )}
                          <circle cx={leg.cx} cy={leg.cy} r={18} fill={palette.accent} stroke={palette.border} strokeWidth={1.5} />
                          <text x={leg.cx} y={leg.cy + 34} textAnchor="middle" fontSize={12} fill={palette.light}>
                            {leg.label} ({(identityProfilesMap[leg.id] || []).length})
                          </text>
                        </g>
                      ))}

                      {/* profiles */}
                      {profilePositions.map((p) => {
                        const clipId = `avatar-clip-${p.id}`;
                        const legMeta = legPositions.find((l) => l.id === p.legId);
                        return (
                          <g key={p.id}>
                            {showConnections && legMeta && (
                              <line x1={legMeta.cx} y1={legMeta.cy} x2={p.x} y2={p.y} stroke={palette.border} strokeWidth={1.3} strokeOpacity={0.75} />
                            )}
                            {/* avatar halo to sit above connecting lines */}
                            <circle cx={p.x} cy={p.y} r={24} fill={palette.panelDark} stroke={palette.border} strokeWidth={1.2} />
                            <defs>
                              <clipPath id={clipId}>
                                <circle cx="20" cy="20" r="20" />
                              </clipPath>
                            </defs>
                            {p.avatar && (
                              <g transform={`translate(${p.x - 20}, ${p.y - 20})`}>
                                <image href={p.avatar} width="40" height="40" clipPath={`url(#${clipId})`} />
                              </g>
                            )}
                            {!p.avatar && <circle cx={p.x} cy={p.y} r={10} fill={palette.light} />}
                            <text x={p.x} y={p.y + 32} textAnchor="middle" fontSize={12} fill={palette.light}>
                              {(p.label || p.id || "").slice(0, 28)}
                            </text>
                            <circle
                              cx={p.x}
                              cy={p.y}
                              r={26}
                              fill="transparent"
                              stroke="none"
                              onClick={() => {
                                const modalProfile = deepProfiles.find((dp) => dp.platform === p.id);
                                if (modalProfile) {
                                  openProfileModal(modalProfile);
                                }

                                const legId = p.legId;
                                const branchProfiles = (identityProfilesMap[legId] || []).map((node) => {
                                  const match = deepProfiles.find((dp) => dp.platform === node.id);
                                  if (match) return match;
                                  return {
                                    platform: node.id,
                                    url: node.url || getPlatformUrl(node.id, username || ""),
                                    displayName: node.label || node.id,
                                    bio: (node as any).bio || "",
                                    avatar: (node as any).avatar || fallbackAvatar(node.label || node.id),
                                    category: (node as any).category,
                                  } as DeepProfileResult;
                                });

                                setActiveBranch({
                                  label: legMeta?.label || "Branch",
                                  nodes: branchProfiles,
                                  basis: describeBranchBasis(legMeta),
                                  viewMode: branchMode,
                                  category: p.category || null,
                                });
                              }}
                              style={{ cursor: "pointer" }}
                            />
                          </g>
                        );
                      })}
                    </g>
                  </svg>
                </div>

                <div className="text-xs" style={{ color: palette.light }}>
                  Central node = searched handle; View All links by detected pivots; By category groups by availability categories. Click a profile to see only that leg and the reason.
                </div>
              </div>
            );
          })()}
          </>
          )}
        </section>
        )}

        {deepProfiles.length > 0 && (
          <section ref={analyzerSectionRef} className="space-y-3 rounded-xl border" tabIndex={-1} style={{ borderColor: palette.border }}>
          <div className="flex items-center justify-between py-3" style={{ minHeight: 88, paddingRight: 15 }}>
            <button
              onClick={() => setLlmCollapsed((v) => !v)}
              className="flex items-center gap-2 text-left"
              aria-expanded={!llmCollapsed}
            >
              <ChevronDown className={`w-5 h-5 transition-transform ${llmCollapsed ? "-rotate-90" : "rotate-0"}`} />
              <h2 className="text-xl font-semibold">LLM Analyser</h2>
            </button>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setExportCollapsed(false);
                  scrollAndFocus(exportSectionRef);
                }}
                disabled={!results.length && !deepProfiles.length}
                className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium whitespace-nowrap disabled:cursor-not-allowed"
                style={{
                  ...phaseButtonStyle(!(!results.length && !deepProfiles.length), phases.export || true),
                  width: 240,
                  height: 42,
                }}
              >
                <Play className="w-4 h-4" /> Next phase → Export data
              </button>
            </div>
          </div>
          {!llmCollapsed && (
          <>
          {analysisError && <div className="text-sm text-rose-300">{analysisError}</div>}
          {(heuristicResult || !heuristicResult) && (
            <div className="p-4 rounded-lg border space-y-3" style={{ backgroundColor: palette.panel, borderColor: palette.border }}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-base font-semibold" style={{ color: palette.light }}>Heuristic summary</div>
                  <div className="text-sm whitespace-pre-line" style={{ color: palette.light }}>
                    {heuristicResult ? formatSummary(heuristicResult.summary) : "No heuristic run yet."}
                  </div>
                </div>
                <button
                  onClick={() => {
                    if (isAnalyzing || !deepProfiles.length) return;
                    runHeuristic();
                    scrollAndFocus(analyzerSectionRef);
                  }}
                  disabled={isAnalyzing || !deepProfiles.length}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm disabled:cursor-not-allowed whitespace-nowrap"
                  style={{ backgroundColor: palette.accentDark, border: `1px solid ${palette.border}`, color: palette.light, opacity: isAnalyzing || !deepProfiles.length ? 0.5 : 1 }}
                >
                  <Play className="w-4 h-4" /> {isAnalyzing && phases.llm !== "running" ? "Analysing..." : "Run heuristic"}
                </button>
              </div>
              {heuristicResult?.traits?.length ? (
                <div>
                  <div className="text-sm" style={{ color: palette.light }}>Traits</div>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {heuristicResult.traits.map((t) => (
                      <span key={t} className="px-2 py-1 text-xs rounded-full bg-slate-800 border border-slate-600">{t}</span>
                    ))}
                  </div>
                </div>
              ) : null}
              {heuristicResult?.risks?.length ? (
                <div>
                  <div className="text-sm" style={{ color: palette.light }}>Risks</div>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {heuristicResult.risks.map((r) => (
                      <span key={r} className="px-2 py-1 text-xs rounded-full bg-amber-900/60 border border-amber-700 text-amber-100">{r}</span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}

          {(llmResult || !llmResult) && (
            <div className="p-4 rounded-lg border space-y-3" style={{ backgroundColor: palette.panel, borderColor: palette.border }}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-base font-semibold" style={{ color: palette.light }}>LLM summary {llmResult?.llm_model ? `(${llmResult.llm_model})` : ""}</div>
                  <div className="text-sm whitespace-pre-line" style={{ color: palette.light }}>
                    {llmResult ? formatSummary(llmResult.summary) : "No LLM run yet."}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setSettingsOpen(true)}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm"
                    style={{ backgroundColor: palette.panel, border: `1px solid ${palette.border}`, color: palette.light }}
                    aria-label="Open analyser settings"
                  >
                    <Settings className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => {
                      if (isAnalyzing || !deepProfiles.length || phases.heuristic !== "done" || !useLLM) return;
                      runLlm();
                      scrollAndFocus(analyzerSectionRef);
                    }}
                    disabled={isAnalyzing || !deepProfiles.length || phases.heuristic !== "done" || !useLLM}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm disabled:cursor-not-allowed whitespace-nowrap"
                    style={phaseButtonStyle(!(isAnalyzing || !deepProfiles.length || phases.heuristic !== "done" || !useLLM), phases.heuristic === "done")}
                  >
                    <Play className="w-4 h-4" /> {isAnalyzing && phases.llm === "running" ? "Analysing..." : "Run LLM"}
                  </button>
                </div>
              </div>
              {llmResult?.traits?.length ? (
                <div>
                  <div className="text-sm" style={{ color: palette.light }}>Traits</div>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {llmResult.traits.map((t) => (
                      <span key={t} className="px-2 py-1 text-xs rounded-full bg-slate-800 border border-slate-600">{t}</span>
                    ))}
                  </div>
                </div>
              ) : null}
              {llmResult?.risks?.length ? (
                <div>
                  <div className="text-sm" style={{ color: palette.light }}>Risks</div>
                  <div className="flex flex-wrap gap-2 mt-1">
                    {llmResult.risks.map((r) => (
                      <span key={r} className="px-2 py-1 text-xs rounded-full bg-amber-900/60 border border-amber-700 text-amber-100">{r}</span>
                    ))}
                  </div>
                </div>
              ) : null}
              {llmResult?.llm_error && <div className="text-xs text-amber-300">LLM fallback: {llmResult.llm_error}</div>}
            </div>
          )}
          </>
          )}
        </section>
        )}

        {(results.length > 0 || deepProfiles.length > 0) && (
          <section className="space-y-3 rounded-xl border" ref={exportSectionRef} style={{ borderColor: palette.border }}>
          <div className="flex items-center justify-between py-3" style={{ minHeight: 88, paddingRight: 15 }}>
            <button
              onClick={() => setExportCollapsed((v) => !v)}
              className="flex items-center gap-2 text-left"
              aria-expanded={!exportCollapsed}
            >
              <ChevronDown className={`w-5 h-5 transition-transform ${exportCollapsed ? "-rotate-90" : "rotate-0"}`} />
              <h2 className="text-xl font-semibold">Export</h2>
            </button>
            <div />
          </div>

          {!exportCollapsed && (
            <div
              className="flex flex-col items-start gap-3 text-left pb-4 px-4 rounded-lg border"
              style={{ backgroundColor: palette.panel, borderColor: palette.border }}
            >
              <div className="w-full flex items-center justify-between gap-4 text-left" style={{ marginTop: 15 }}>
                <div className="text-sm leading-snug" style={{ color: "#facc15" }}>
                  All data exported here is under the responsibility of the user, not the developer.
                </div>
                <div className="flex items-center gap-3 justify-end">
                  <button
                    onClick={previewExport}
                    disabled={!results.length && !deepProfiles.length}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm disabled:opacity-50 whitespace-nowrap"
                    style={{ backgroundColor: "#065f46", border: "1px solid #0f9f6c", color: "#e6fff4" }}
                  >
                    <Eye className="w-4 h-4" /> Preview
                  </button>
                  <button
                    onClick={exportJson}
                    disabled={!results.length && !deepProfiles.length || exporting}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm disabled:opacity-50 whitespace-nowrap"
                    style={{ backgroundColor: "#065f46", border: "1px solid #0f9f6c", color: "#e6fff4" }}
                  >
                    <Download className="w-4 h-4" /> {exporting ? "Exporting..." : "Export JSON"}
                  </button>
                  <button
                    onClick={exportHtml}
                    disabled={!results.length && !deepProfiles.length || exportingHtml}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm disabled:opacity-50 whitespace-nowrap"
                    style={{ backgroundColor: "#065f46", border: "1px solid #0f9f6c", color: "#e6fff4" }}
                  >
                    <FileText className="w-4 h-4" /> {exportingHtml ? "Exporting..." : "Export HTML"}
                  </button>
                </div>
              </div>
            </div>
          )}
          </section>
        )}
      </div>

      </div>

      {settingsOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center px-4 z-50">
          <div
            className="w-full max-w-xl rounded-xl shadow-2xl p-6 relative"
            style={{ backgroundColor: palette.panel, border: `1px solid ${palette.border}` }}
          >
            <button
              onClick={() => setSettingsOpen(false)}
              className="absolute top-3 right-3 text-gray-400 hover:text-white"
              aria-label="Close settings"
            >
              ×
            </button>
            <h3 className="text-lg font-semibold mb-4">Analyser settings</h3>
            <div className="space-y-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={useLLM} onChange={(e) => setUseLLM(e.target.checked)} className="accent-purple-500" />
                Use local Ollama (LLM)
              </label>
              <div>
                <div className="text-xs" style={{ color: palette.light }}>Ollama host</div>
                <div className="flex gap-2">
                  <input
                    value={ollamaHost}
                    onChange={(e) => setOllamaHost(e.target.value)}
                    className="flex-1 px-3 py-2 rounded-lg"
                    style={{ backgroundColor: palette.bg, border: `1px solid ${palette.border}`, color: palette.light }}
                  />
                  <button
                    onClick={connectOllama}
                    className="px-3 py-2 rounded-lg text-xs"
                    style={{ backgroundColor: palette.accentDark, border: `1px solid ${palette.border}`, color: palette.light }}
                    disabled={ollamaStatus === "connecting"}
                  >
                    {ollamaStatus === "connecting" ? "Connecting..." : "Connect"}
                  </button>
                </div>
                {ollamaStatus === "ready" && <div className="text-[11px] text-emerald-300 mt-1">{ollamaModels.length} model(s) available</div>}
                {ollamaStatus === "error" && <div className="text-[11px] text-rose-300 mt-1">{ollamaError}</div>}
              </div>
              <div>
                <div className="text-xs" style={{ color: palette.light }}>Model</div>
                <select
                  value={llmModel}
                  onChange={(e) => setLlmModel(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg"
                  style={{ backgroundColor: palette.bg, border: `1px solid ${palette.border}`, color: palette.light }}
                >
                  {[llmModel, ...ollamaModels.filter((m) => m !== llmModel)].map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <button
                  onClick={testOllamaConnection}
                  className="px-3 py-2 rounded-lg"
                  style={{ backgroundColor: palette.panelDark, border: `1px solid ${palette.border}`, color: palette.light }}
                  disabled={ollamaTestStatus === "testing"}
                >
                  {ollamaTestStatus === "testing" ? "Testing..." : "Test Ollama"}
                </button>
                {ollamaTestStatus === "success" && ollamaTestMessage && <span className="text-emerald-300">{ollamaTestMessage}</span>}
                {ollamaTestStatus === "error" && ollamaTestMessage && <span className="text-rose-300">{ollamaTestMessage}</span>}
              </div>
              <div>
                <div className="text-xs" style={{ color: palette.light }}>API mode</div>
                <select
                  value={llmApiMode}
                  onChange={(e) => setLlmApiMode(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg"
                  style={{ backgroundColor: palette.bg, border: `1px solid ${palette.border}`, color: palette.light }}
                >
                  <option value="ollama">Ollama /api/generate</option>
                  <option value="openai">OpenAI-compatible /v1/chat</option>
                </select>
              </div>
              <div>
                <div className="text-xs" style={{ color: palette.light }}>Prompt override</div>
                <textarea
                  value={analyzerPrompt}
                  onChange={(e) => setAnalyzerPrompt(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg min-h-[100px]"
                  style={{ backgroundColor: palette.bg, border: `1px solid ${palette.border}`, color: palette.light }}
                  placeholder="You are a concise profile analyst..."
                />
                <div className="text-[11px] text-gray-500 mt-1">If empty, the default concise prompt is used.</div>
              </div>
              <div className="flex items-center gap-3 pt-1">
                <button
                  onClick={saveSettings}
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg text-sm"
                  style={{ backgroundColor: palette.accentDark, border: `1px solid ${palette.border}`, color: palette.light }}
                >
                  <Save className="w-4 h-4" /> Save settings
                </button>
                {savedMessage && <span className="text-xs text-emerald-300">{savedMessage}</span>}
              </div>
            </div>
          </div>
        </div>
      )}

      {activeProfile && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center px-4 z-50" onClick={closeProfileModal}>
          <div
            className="w-full max-w-6xl rounded-xl shadow-2xl p-7 relative"
            style={{ backgroundColor: palette.panel, border: `1px solid ${palette.border}`, width: "min(1200px, 96vw)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={closeProfileModal}
              className="absolute top-3 right-3 text-gray-400 hover:text-white"
              aria-label="Close profile"
            >
              <X className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-14 h-14 rounded-full flex items-center justify-center" style={{ backgroundColor: palette.panelDark, border: `1px solid ${palette.border}` }}>
                <Image src={logo} alt="deepkrak3n logo" className="rounded-full" width={44} height={44} />
              </div>
              <div>
                <div className="text-lg font-semibold" style={{ color: palette.light }}>deepkrak3n</div>
                <div className="text-sm" style={{ color: palette.light }}>
                  {connectBy === "email" ? "MindMap search based on email" : "MindMap search based on username"}
                </div>
              </div>
            </div>

            <div className="text-sm whitespace-pre-wrap mb-3" style={{ color: palette.light }}>
              {(() => {
                const mode = activeBranch?.viewMode;
                const cat = activeBranch?.category;

                if (mode === "category") {
                  const label = cat || "category";
                  return `These profiles are grouped because they share the site category “${label}”.`;
                }

                if (mode === "likelihood") {
                  return "These profiles are ranked as the most likely to belong to the same person based on the search pivots.";
                }

                if (activeBranch?.basis) {
                  const { type, value, note } = activeBranch.basis;
                  return `This branch exists because the profiles share ${type} “${value}”. ${note}`;
                }
                if (connectBy === "email" && email) return `This branch groups profiles that matched the searched email “${email}”.`;
                if (connectBy === "profile") return "This branch connects profiles that reuse the same display name across platforms.";
                return "This branch connects profiles that reuse the searched username across platforms.";
              })()}
            </div>
            <div className="text-xs" style={{ color: palette.light }}>
              Branch anchor: {activeBranch?.basis?.value || activeBranch?.category || (connectBy === "email" ? email || "email pivot" : username || "username pivot")}
            </div>

            {activeBranch && (
              <div className="mt-4 space-y-2">
                <div className="max-h-[60vh] overflow-y-auto pr-1">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    {activeBranch.nodes.map((node, idx) => (
                      <div
                        key={`${activeBranch.label}-${node.platform}-${idx}`}
                        className="p-5 rounded-2xl border flex items-start gap-4"
                        style={{ backgroundColor: palette.panelDark, borderColor: palette.border, minHeight: 180 }}
                      >
                        <img src={node.avatar} alt={`${node.platform} avatar`} className="w-14 h-14 rounded-full" style={{ backgroundColor: palette.bg }} />
                        <div className="min-w-0 space-y-1">
                          <div className="font-semibold text-base leading-tight" style={{ color: palette.light }}>{node.displayName}</div>
                          <div className="text-sm" style={{ color: palette.light }}>{node.platform}</div>
                          {node.category && <div className="text-xs text-gray-400">{node.category}</div>}
                          {node.url && (
                            <a
                              href={node.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-xs underline"
                              style={{ color: palette.light }}
                            >
                              Open profile
                            </a>
                          )}
                          {node.bio && <div className="text-sm text-gray-300 mt-1 leading-snug line-clamp-4">{node.bio}</div>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {showPreview && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center px-4 z-50" onClick={() => setShowPreview(false)}>
          <div
            className="w-full max-w-4xl h-[80vh] rounded-xl shadow-2xl relative"
            style={{ backgroundColor: palette.panel, border: `1px solid ${palette.border}` }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setShowPreview(false)}
              className="absolute top-3 right-3 text-gray-400 hover:text-white"
              aria-label="Close preview"
            >
              <X className="w-5 h-5" />
            </button>
            <div className="h-full overflow-auto">
              <div className="p-4 text-sm" style={{ color: palette.light }} dangerouslySetInnerHTML={{ __html: previewHtml }} />
            </div>
          </div>
        </div>
      )}

      {showBackToTop && (
        <button
          onClick={() => {
            if (typeof window !== "undefined") {
              window.scrollTo({ top: 0, behavior: "smooth" });
            }
          }}
          className="fixed right-6 bottom-6 z-40 shadow-lg flex items-center gap-2 px-3 py-2 rounded-full"
          style={{ backgroundColor: palette.panelDark, border: `1px solid ${palette.border}`, color: palette.light }}
          aria-label="Back to top"
        >
          <ArrowUp className="w-4 h-4" />
          <span className="text-sm">Back to top</span>
        </button>
      )}

      <footer
        className="mt-12"
        style={{
          height: 100,
          flexShrink: 0,
          // Stretch footer visuals to full viewport width, compensating for the page padding
          marginLeft: "calc(50% - 50vw)",
          marginRight: "calc(50% - 50vw)",
          width: "100vw",
        }}
      >
        <div style={{ position: "relative", height: "100%", overflow: "hidden", background: palette.bg }}>
          <svg
            viewBox="0 0 150 40"
            preserveAspectRatio="none"
            style={{ position: "absolute", bottom: 0, left: 0, width: "100%", height: "100%" }}
          >
            <defs>
              <linearGradient id="wave-fill" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor={palette.accent} stopOpacity="0.75" />
                <stop offset="100%" stopColor={palette.accentDark} stopOpacity="0.75" />
              </linearGradient>
              <path id="gentle-wave" d="M-160 30c30 0 58-12 88-12s58 12 88 12 58-12 88-12 58 12 88 12v22H-160z" />
            </defs>
            <g>
              <motion.use
                xlinkHref="#gentle-wave"
                x="48"
                y="0"
                fill="rgba(53,48,85,0.28)"
                animate={{ x: [-90, 90] }}
                transition={{ duration: 20, repeat: Infinity, repeatType: "mirror", ease: "easeInOut" }}
              />
              <motion.use
                xlinkHref="#gentle-wave"
                x="48"
                y="2"
                fill="rgba(41,34,65,0.35)"
                animate={{ x: [-70, 70] }}
                transition={{ duration: 14, repeat: Infinity, repeatType: "mirror", ease: "easeInOut" }}
              />
              <motion.use
                xlinkHref="#gentle-wave"
                x="48"
                y="4"
                fill="rgba(19,21,33,0.45)"
                animate={{ x: [-50, 50] }}
                transition={{ duration: 11, repeat: Infinity, repeatType: "mirror", ease: "easeInOut" }}
              />
              <motion.use
                xlinkHref="#gentle-wave"
                x="48"
                y="6"
                fill="url(#wave-fill)"
                animate={{ x: [-30, 30] }}
                transition={{ duration: 8, repeat: Infinity, repeatType: "mirror", ease: "easeInOut" }}
              />
            </g>
          </svg>
          <div
            style={{ position: "relative", zIndex: 1, height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: palette.light, fontSize: 12 }}
          >
            <div className="flex items-center gap-4 text-center sm:text-left">
              <Image src="/favicon-64.png" alt="deepkrak3n logo" width={48} height={48} className="flex-shrink-0" />
              <div className="flex flex-col items-start gap-1">
                <div>deepkrak3n is an educational OSINT app for profile analysis; public data only, nothing stored locally.</div>
                <a
                  href="https://github.com/guilhermelimait/deepkrak3n"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-2 text-sm hover:underline"
                  style={{ color: palette.light }}
                >
                  <span>View the project on GitHub</span>
                </a>
              </div>
            </div>
          </div>
        </div>
      </footer>
      <style jsx global>{`
        .bubble-layer {
          position: fixed;
          inset: 0;
          overflow: hidden;
          pointer-events: none;
          z-index: 0;
        }
        .bubble {
          position: absolute;
          bottom: -80px;
          border-radius: 9999px;
          background: rgba(154, 160, 181, 0.24);
          box-shadow: 0 0 24px rgba(6, 7, 13, 0.38), 0 0 60px rgba(6, 7, 13, 0.2);
          opacity: 0.3;
          animation: bubble-rise 18s ease-in-out infinite, bubble-drift 6s ease-in-out infinite alternate;
          filter: saturate(1.08);
        }
        .bubble::before {
          content: "";
          position: absolute;
          inset: 12%;
          border-radius: 9999px;
          background: rgba(6, 7, 13, 0.85);
          opacity: 0.7;
          filter: blur(0.3px);
        }
        .bubble::after {
          content: "";
          position: absolute;
          width: 18%;
          height: 18%;
          top: 18%;
          left: 22%;
          border-radius: 9999px;
          background: rgba(255,255,255,0.45);
          filter: blur(1px);
          opacity: 0.9;
        }
        .bubble--1 { left: 8%; width: 32px; height: 32px; animation-duration: 18s, 5s; animation-delay: 0.6s, 0.2s; }
        .bubble--2 { left: 18%; width: 18px; height: 18px; animation-duration: 16s, 4s; animation-delay: 1.2s, 0.4s; opacity: 0.14; }
        .bubble--3 { left: 28%; width: 12px; height: 12px; animation-duration: 22s, 6s; animation-delay: 5s, 1s; opacity: 0.24; }
        .bubble--4 { left: 36%; width: 26px; height: 26px; animation-duration: 19s, 4.6s; animation-delay: 8s, 1.3s; opacity: 0.18; }
        .bubble--5 { left: 52%; width: 30px; height: 30px; animation-duration: 17s, 4.8s; animation-delay: 10s, 1.5s; opacity: 0.16; }
        .bubble--6 { left: 64%; width: 14px; height: 14px; animation-duration: 28s, 5.6s; animation-delay: 3s, 0.8s; opacity: 0.26; }
        .bubble--7 { left: 74%; width: 16px; height: 16px; animation-duration: 24s, 4.4s; animation-delay: 12s, 1.1s; opacity: 0.2; }
        .bubble--8 { left: 82%; width: 22px; height: 22px; animation-duration: 20s, 5.2s; animation-delay: 6s, 0.9s; opacity: 0.2; }
        .bubble--9 { left: 44%; width: 20px; height: 20px; animation-duration: 21s, 4.2s; animation-delay: 7s, 1.2s; opacity: 0.18; }
        .bubble--10 { left: 58%; width: 36px; height: 36px; animation-duration: 18s, 5.4s; animation-delay: 14s, 1.4s; opacity: 0.22; }
        .bubble--11 { left: 90%; width: 26px; height: 26px; animation-duration: 20s, 4.5s; animation-delay: 9s, 1s; opacity: 0.2; }
        .bubble--12 { left: 4%; width: 18px; height: 18px; animation-duration: 25s, 5s; animation-delay: 11s, 0.7s; opacity: 0.16; }
        @keyframes bubble-rise {
          0% { transform: translateY(0) scale(1); opacity: 0.12; }
          100% { transform: translateY(-120vh) scale(1.08); opacity: 0.5; }
        }
        @keyframes bubble-drift {
          0% { margin-left: 0; }
          100% { margin-left: 160px; }
        }
        @media (prefers-reduced-motion: reduce) {
          .bubble { animation: none; opacity: 0.08; }
        }
        .glitch-logo {
          position: relative;
          display: inline-block;
        }
        .glitch-logo img {
          animation: logo-glitch 2.8s ease-in-out infinite 1s;
        }
        @keyframes logo-glitch {
          0% { filter: drop-shadow(-2px 2px 0 #b91c1c) drop-shadow(2px -2px 0 #2563eb); transform: translate(0, 0); }
          4% { filter: drop-shadow(2px -2px 0 #b91c1c) drop-shadow(-2px 2px 0 #2563eb); transform: translate(-2px, 1px); }
          6% { filter: none; transform: translate(2px, -1px); }
          8% { filter: drop-shadow(-1px 1px 0 #b91c1c) drop-shadow(1px -1px 0 #2563eb); transform: translate(-1px, 0); }
          10% { filter: none; transform: translate(0, 0); }
          100% { filter: none; transform: translate(0, 0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .glitch-logo img { animation: none; }
        }
        .stack-title {
          display: flex;
          flex-direction: column;
          gap: 4px;
          line-height: 1.1;
          letter-spacing: 0.04em;
        }
        .stack-title .stack {
          display: grid;
          grid-template-columns: 1fr;
        }
        .stack-title .stack span {
          font-weight: 800;
          font-size: 2.4rem;
          grid-row-start: 1;
          grid-column-start: 1;
          --stack-height: calc(100% / var(--stacks) - 1px);
          --inverse-index: calc(calc(var(--stacks) - 1) - var(--index));
          --clip-top: calc(var(--stack-height) * var(--index));
          --clip-bottom: calc(var(--stack-height) * var(--inverse-index));
          clip-path: inset(var(--clip-top) 0 var(--clip-bottom) 0);
          animation: stack 340ms cubic-bezier(.46,.29,0,1.24) 1 backwards calc(var(--index) * 120ms), glitch 2.2s ease infinite 2.1s alternate-reverse;
          text-transform: lowercase;
        }
        .stack-title .stack span:nth-child(odd) { --glitch-translate: 7px; }
        .stack-title .stack span:nth-child(even) { --glitch-translate: -7px; }
        .stack-title .stack-sub {
          font-size: 0.95rem;
          color: ${palette.light};
          opacity: 0.9;
        }
        @keyframes stack {
          0% {
            opacity: 0;
            transform: translateX(-40%);
            text-shadow: -2px 3px 0 #b91c1c, 2px -3px 0 #2563eb;
          }
          60% {
            opacity: 0.6;
            transform: translateX(40%);
          }
          80% {
            transform: none;
            opacity: 1;
            text-shadow: 2px -3px 0 #b91c1c, -2px 3px 0 #2563eb;
          }
          100% {
            text-shadow: none;
          }
        }
        @keyframes glitch {
          0% {
            text-shadow: -2px 3px 0 #b91c1c, 2px -3px 0 #2563eb;
            transform: translate(var(--glitch-translate));
          }
          2% {
            text-shadow: 2px -3px 0 #b91c1c, -2px 3px 0 #2563eb;
          }
          4%, 100% { text-shadow: none; transform: none; }
        }
        @media (max-width: 640px) {
          .stack-title .stack span { font-size: 1.8rem; }
          .stack-title .stack-sub { font-size: 0.85rem; }
        }
      `}</style>
    </div>
  );
}