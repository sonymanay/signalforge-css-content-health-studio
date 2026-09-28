const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8787);
const DASHBOARD_FILE = path.join(__dirname, "index.html");
const TELEMETRY_FILE = process.env.CONTENT_HEALTH_TELEMETRY_FILE || path.join(__dirname, "content-health-telemetry.json");

const SOURCE_CONFIGS = [
  {
    key: "learn",
    name: "LMC",
    endpoint: process.env.LEARN_MCP_ENDPOINT || "https://learn.microsoft.com/api/mcp",
    tool: process.env.LEARN_MCP_TOOL || "microsoft_docs_search",
    token: process.env.LEARN_MCP_TOKEN || ""
  },
  {
    key: "smc",
    name: "SMC",
    endpoint: process.env.SMC_MCP_ENDPOINT || "https://learn.microsoft.com/api/mcp/smc",
    tool: process.env.SMC_MCP_TOOL || "microsoft_support_search",
    token: process.env.SMC_MCP_TOKEN || ""
  },
  {
    key: "evergreen",
    name: "Evergreen",
    endpoint: process.env.EVERGREEN_MCP_ENDPOINT || "https://learn.microsoft.com/api/mcp/evergreen",
    tool: process.env.EVERGREEN_MCP_TOOL || "",
    token: process.env.EVERGREEN_MCP_TOKEN || process.env.MCP_AUTH_TOKEN || ""
  },
  {
    key: "cssWiki",
    name: "CSS Wiki",
    endpoint: process.env.CSS_WIKI_MCP_ENDPOINT || "",
    tool: process.env.CSS_WIKI_MCP_TOOL || "",
    token: process.env.CSS_WIKI_MCP_TOKEN || process.env.MCP_AUTH_TOKEN || ""
  }
];

const CONTENT_HUB_INSIGHTS = {
  capturedFrom: "Kaushik Content Hub demo",
  benchmarkMetrics: [
    { label: "Pull requests", value: "~600", detail: "PRs observed over the last three months" },
    { label: "CPM triage SLA", value: "95%", detail: "Triage SLA benchmark from the Content Hub PR dashboard" },
    { label: "SME reviews", value: "50%", detail: "Review coverage benchmark shown in the Content Hub demo" },
    { label: "Page views", value: "Tracked", detail: "Consumption and performance signal" },
    { label: "Page-view quality", value: "Tracked", detail: "Quality-adjusted view signal, not just raw traffic" },
    { label: "Cost avoidance", value: "Tracked", detail: "Business impact signal for content value" },
    { label: "Content opportunities", value: "Tracked", detail: "Backlog signal for gaps, improvements, and new content" },
    { label: "Traffic sources", value: "Tracked", detail: "Attribution across LLM traffic, MVP calls, and other sources" }
  ],
  healthSignals: [
    "Freshness Checker",
    "Repository-wide freshness scanning",
    "Quality scan visibility",
    "Content consumption patterns",
    "Repository activity",
    "ADO work item visibility",
    "Pull request activity"
  ],
  actionDestinations: [
    {
      name: "Rubik",
      action: "Create or update articles and submit downstream PRs",
      useWhen: "New content or major rewrite is needed"
    },
    {
      name: "Content Mentor",
      action: "Select content, improve it, and use guided publishing workflows",
      useWhen: "Content needs assisted authoring, quality improvement, or publishing"
    },
    {
      name: "PR review",
      action: "Review checks, manage PR state, and resolve downstream validation findings",
      useWhen: "Content has entered repo workflow"
    },
    {
      name: "ADO",
      action: "Track work items, ownership, and backlog follow-through",
      useWhen: "Action needs assignment, sprint tracking, or dependency management"
    },
    {
      name: "Freshness Checker",
      action: "Run a rescan and identify stale content by repository",
      useWhen: "Freshness or review-date risk is detected"
    }
  ]
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function loadPageViewTelemetry() {
  if (!fs.existsSync(TELEMETRY_FILE)) {
    return new Map();
  }

  const raw = fs.readFileSync(TELEMETRY_FILE, "utf8");
  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed) ? parsed : parsed.articles || [];
  return new Map(entries.filter((entry) => entry.url).map((entry) => [entry.url, entry]));
}

function serveDashboard(response) {
  fs.readFile(DASHBOARD_FILE, (error, content) => {
    if (error) {
      sendJson(response, 500, { error: `Unable to read dashboard: ${error.message}` });
      return;
    }

    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store"
    });
    response.end(content);
  });
}

function parseSseOrJson(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return {};
  }

  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed);
  }

  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);

  if (!dataLines.length) {
    throw new Error(`Unexpected MCP response: ${trimmed.slice(0, 160)}`);
  }

  return JSON.parse(dataLines[dataLines.length - 1]);
}

function postJson(url, headers, payload) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = https.request(
      {
        method: "POST",
        hostname: target.hostname,
        path: `${target.pathname}${target.search}`,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...headers
        }
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const error = new Error(`HTTP ${response.statusCode}`);
            error.statusCode = response.statusCode;
            error.body = body;
            reject(error);
            return;
          }

          try {
            resolve(parseSseOrJson(body));
          } catch (error) {
            reject(error);
          }
        });
      }
    );

    request.on("error", reject);
    request.setTimeout(30000, () => {
      request.destroy(new Error("MCP request timed out"));
    });
    request.write(JSON.stringify(payload));
    request.end();
  });
}

async function callMcp(source, method, params) {
  const headers = {};
  if (source.token) {
    headers.Authorization = source.token.startsWith("Bearer ") ? source.token : `Bearer ${source.token}`;
  }

  const envelope = await postJson(source.endpoint, headers, {
    jsonrpc: "2.0",
    id: Date.now(),
    method,
    params
  });

  if (envelope.error) {
    throw new Error(envelope.error.message || JSON.stringify(envelope.error));
  }

  return envelope.result;
}

async function discoverSearchTool(source) {
  if (source.tool) {
    return source.tool;
  }

  const result = await callMcp(source, "tools/list", {});
  const tools = result.tools || [];
  const searchTool = tools.find((tool) => /search/i.test(tool.name));
  if (!searchTool) {
    throw new Error("No MCP search tool found; set *_MCP_TOOL explicitly.");
  }

  return searchTool.name;
}

function extractResults(toolResult) {
  if (toolResult?.results) {
    return toolResult.results;
  }

  const textBlock = toolResult?.content?.find((item) => item.type === "text")?.text;
  if (!textBlock) {
    return [];
  }

  try {
    const parsed = JSON.parse(textBlock);
    return parsed.results || [];
  } catch {
    return [];
  }
}

function words(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3);
}

function actionabilityScore(results) {
  const actionTerms = [
    "step",
    "steps",
    "resolve",
    "troubleshoot",
    "workaround",
    "configure",
    "update",
    "install",
    "diagnostic",
    "restart",
    "verify"
  ];
  if (!results.length) {
    return 0;
  }

  const actionable = results.filter((result) => {
    const content = `${result.title || ""} ${result.content || ""}`.toLowerCase();
    return actionTerms.some((term) => content.includes(term));
  }).length;

  return Math.round((actionable / results.length) * 100);
}

function metadataCoverage(results) {
  if (!results.length) {
    return 0;
  }

  const covered = results.filter((result) => {
    return Boolean(result.title && (result.contentUrl || result.url || result.link) && result.content);
  }).length;

  return Math.round((covered / results.length) * 100);
}

function freshnessScore(results) {
  if (!results.length) {
    return 0;
  }

  const now = new Date();
  let dated = 0;
  let score = 0;

  for (const result of results) {
    const content = `${result.title || ""}\n${result.content || ""}`;
    const match = content.match(/Last Updated:\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
    if (!match) {
      continue;
    }

    const date = new Date(match[1]);
    if (Number.isNaN(date.getTime())) {
      continue;
    }

    dated += 1;
    const ageDays = Math.max(0, Math.round((now - date) / 86400000));
    if (ageDays <= 180) score += 100;
    else if (ageDays <= 365) score += 80;
    else if (ageDays <= 730) score += 55;
    else score += 30;
  }

  return dated ? Math.round(score / dated) : 50;
}

function extractLastUpdated(result) {
  const content = `${result.title || ""}\n${result.content || ""}`;
  const match = content.match(/Last Updated:\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})/i);
  if (!match) {
    return null;
  }

  const date = new Date(match[1]);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return {
    label: match[1],
    ageDays: Math.max(0, Math.round((Date.now() - date.getTime()) / 86400000))
  };
}

function deriveRepo(sourceName, url) {
  if (!url) {
    return "Unknown repo";
  }

  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (sourceName === "SMC") {
      return parts[0] === "support" && parts[1] ? `support/${parts[1]}` : parts[0] || "support";
    }

    if (sourceName === "LMC") {
      return parts[0] || "learn";
    }

    return parts[0] || parsed.hostname;
  } catch {
    return "Unknown repo";
  }
}

function inferArticleState(result) {
  const content = `${result.title || ""}\n${result.content || ""}`.toLowerCase();
  if (content.includes("status: fixed") || content.includes("fixed")) return "Fixed";
  if (content.includes("status: workaround") || content.includes("workaround")) return "Workaround";
  if (content.includes("known issue")) return "Known issue";
  if (content.includes("preview")) return "Preview";
  if (content.includes("deprecated") || content.includes("retired")) return "Deprecated";
  return "Published";
}

function qualitySignalsForResult(result, sourceName, linkState) {
  const lastUpdated = extractLastUpdated(result);
  const hasMetadata = Boolean(result.title && (result.contentUrl || result.url || result.link) && result.content);
  const hasAction = actionabilityScore([result]) >= 80;
  const state = inferArticleState(result);
  const freshness =
    !lastUpdated ? "Missing" : lastUpdated.ageDays <= 365 ? "Current" : lastUpdated.ageDays <= 730 ? "Aging" : "Stale";
  const linkHealthy = linkState === "OK";
  const score = Math.max(
    0,
    Math.round(
      (hasMetadata ? 25 : 0) +
        (hasAction ? 25 : 0) +
        (freshness === "Current" ? 25 : freshness === "Aging" ? 15 : freshness === "Stale" ? 5 : 0) +
        (linkHealthy ? 15 : 0) +
        (state === "Deprecated" ? 0 : 10)
    )
  );

  return {
    score,
    freshness,
    lastUpdated: lastUpdated?.label || "Not exposed",
    state,
    linkState,
    metadata: hasMetadata ? "Complete" : "Incomplete",
    actionability: hasAction ? "Actionable" : "Needs clearer next step",
    sourceSystem: sourceName
  };
}

function checkUrlStatus(url) {
  if (!url || !url.startsWith("https://")) {
    return Promise.resolve("Not checked");
  }

  return new Promise((resolve) => {
    const request = https.request(url, { method: "HEAD", timeout: 8000 }, (response) => {
      response.resume();
      if (response.statusCode >= 200 && response.statusCode < 400) {
        resolve("OK");
      } else {
        resolve(`HTTP ${response.statusCode}`);
      }
    });

    request.on("timeout", () => {
      request.destroy();
      resolve("Timeout");
    });
    request.on("error", () => resolve("Check failed"));
    request.end();
  });
}

function sourceHealth(results, duplicateCount, connected) {
  if (!connected) {
    return 0;
  }

  const coverage = metadataCoverage(results);
  const actionability = actionabilityScore(results);
  const freshness = freshnessScore(results);
  const retrieval = Math.min(100, results.length * 10);
  const duplicatePenalty = Math.min(25, duplicateCount * 5);

  return Math.max(
    0,
    Math.round(retrieval * 0.25 + coverage * 0.2 + actionability * 0.25 + freshness * 0.3 - duplicatePenalty)
  );
}

function classify(score) {
  if (score >= 80) {
    return { status: "Healthy", className: "good" };
  }
  if (score >= 60) {
    return { status: "Watch", className: "warn" };
  }
  return { status: "At risk", className: "danger" };
}

function findDuplicateCounts(resultsBySource) {
  const seen = new Map();
  for (const [sourceName, results] of Object.entries(resultsBySource)) {
    for (const result of results) {
      const tokens = words(result.title || "").slice(0, 6).join(" ");
      const url = result.contentUrl || result.url || result.link || "";
      const key = url || tokens;
      if (!key) {
        continue;
      }
      if (!seen.has(key)) {
        seen.set(key, new Set());
      }
      seen.get(key).add(sourceName);
    }
  }

  const counts = {};
  for (const [sourceName] of Object.entries(resultsBySource)) {
    counts[sourceName] = 0;
  }

  for (const sourceSet of seen.values()) {
    if (sourceSet.size <= 1) {
      continue;
    }
    for (const sourceName of sourceSet) {
      counts[sourceName] += 1;
    }
  }

  return counts;
}

function buildContentItems(resultsBySource, sourceScores) {
  const items = [];
  for (const [sourceName, results] of Object.entries(resultsBySource)) {
    const sourceScore = sourceScores[sourceName] || 0;
    const risk = sourceScore < 60 ? "Critical" : sourceScore < 75 ? "High" : "Medium";
    const riskClass = sourceScore < 60 ? "danger" : sourceScore < 75 ? "warn" : "good";

    for (const result of results.slice(0, 3)) {
      const content = result.content || "";
      const hasUpdatedDate = /Last Updated:/i.test(content);
      const hasAction = actionabilityScore([result]) >= 80;
      const action = !hasUpdatedDate ? "Add freshness signal" : hasAction ? "Validate accuracy" : "Improve actionability";
      const actionMeaning = !hasUpdatedDate
        ? "Add or expose review metadata such as Last Updated, next review date, owner, and freshness SLA so CSS users know whether the guidance is current."
        : hasAction
          ? "Have the content owner or SME confirm the guidance still matches current product behavior, policy, and support workflow."
          : "Rewrite the page so it gives CSS users a clear next step, resolution path, escalation path, or workflow handoff.";
      const impact = content.includes("known issue")
        ? "Known issue signal"
        : content.includes("support case")
          ? "Case support signal"
          : "High relevance result";
      const evidence = [
        `${sourceName} MCP search returned this as a top result for the current dashboard topic.`,
        `Source health score: ${sourceScore}%.`,
        hasUpdatedDate ? "Freshness metadata was detected in the content." : "No Last Updated metadata was detected in the returned content excerpt.",
        hasAction ? "The excerpt contains action-oriented terms such as troubleshoot, workaround, configure, or resolve." : "The excerpt has weak action-oriented guidance."
      ];

      items.push({
        title: result.title || "Untitled content",
        source: sourceName,
        owner: "Unassigned",
        risk,
        riskClass,
        action,
        actionMeaning,
        impact,
        evidence,
        identifiedBy: "MCP relevance, freshness metadata, actionability terms, source health score, and known-issue/case-support signals",
        url: result.contentUrl || result.url || result.link || ""
      });
    }
  }

  return items
    .sort((a, b) => {
      const rank = { Critical: 0, High: 1, Medium: 2 };
      return rank[a.risk] - rank[b.risk];
    })
    .slice(0, 8);
}

function buildJourneySegments(allResults) {
  const journeys = [
    { name: "Onboarding", terms: ["start", "overview", "setup", "getting started"] },
    { name: "Case triage", terms: ["triage", "diagnostic", "support case", "issue"] },
    { name: "Known issues", terms: ["known issue", "status", "workaround"] },
    { name: "Escalation", terms: ["escalate", "support engineer", "admin center"] },
    { name: "Policy lookup", terms: ["policy", "compliance", "requirement"] },
    { name: "Resolution", terms: ["resolve", "fix", "troubleshoot", "workaround"] },
    { name: "Handoff", terms: ["owner", "contact", "next step"] }
  ];

  const corpus = allResults.map((result) => `${result.title || ""} ${result.content || ""}`.toLowerCase());
  return journeys.map((journey) => {
    const matches = corpus.filter((text) => journey.terms.some((term) => text.includes(term))).length;
    const score = Math.min(100, Math.round((matches / Math.max(1, corpus.length)) * 120));
    const normalized = score < 35 ? 55 : score;
    return { name: journey.name, score: normalized, className: classify(normalized).className };
  });
}

function buildMcpTrackedMetrics(allResults, sources, resultsBySource, freshness, metadata, actionability, needsAction) {
  const connectedSources = sources.filter((source) => source.connected).map((source) => source.name);
  const sourceBreakdown = Object.entries(resultsBySource)
    .map(([sourceName, results]) => `${sourceName}: ${results.length}`)
    .join(", ");
  const knownIssueCount = allResults.filter((result) => /known issue|workaround|issue/i.test(`${result.title || ""} ${result.content || ""}`)).length;
  const opportunityCount = allResults.filter((result) => !/Last Updated:/i.test(result.content || "")).length + Math.max(0, 100 - actionability);

  return [
    {
      label: "Page views",
      status: "MCP proxy",
      value: `${allResults.length} retrieved`,
      detail: "Current MCP endpoints expose relevant content results, not raw page-view telemetry. This shows the number of live content items retrieved for the dashboard topic.",
      source: connectedSources.length ? connectedSources.join(", ") : "No connected source"
    },
    {
      label: "Page-view quality",
      status: "MCP proxy",
      value: `${Math.round((metadata + actionability) / 2)}%`,
      detail: "Quality proxy based on metadata coverage and action-oriented guidance in the live MCP result set.",
      source: connectedSources.length ? connectedSources.join(", ") : "No connected source"
    },
    {
      label: "Cost avoidance",
      status: "Telemetry needed",
      value: `${knownIssueCount} deflection candidates`,
      detail: "MCP can identify support and known-issue candidates. Actual cost avoidance needs Content Hub analytics, case deflection, or support-cost telemetry.",
      source: sourceBreakdown || "No MCP results"
    },
    {
      label: "Content opportunities",
      status: "MCP live",
      value: `${needsAction}`,
      detail: "Backlog proxy from stale/missing freshness signals, critical source gaps, and weak actionability signals.",
      source: connectedSources.length ? connectedSources.join(", ") : "No connected source"
    },
    {
      label: "Traffic sources",
      status: "MCP source attribution",
      value: `${connectedSources.length}/${sources.length}`,
      detail: "MCP currently attributes source-system coverage. LLM traffic, MVP calls, and external referrer attribution require Content Hub traffic telemetry.",
      source: sourceBreakdown || "No MCP results"
    },
    {
      label: "Freshness signal",
      status: "MCP live",
      value: `${freshness}%`,
      detail: "Computed from Last Updated metadata when available in the live MCP result excerpts.",
      source: connectedSources.length ? connectedSources.join(", ") : "No connected source"
    },
    {
      label: "Content consumption patterns",
      status: "MCP proxy",
      value: `${allResults.length} topic matches`,
      detail: "Shows which content appears for the current topic across connected MCP sources. True consumption patterns need page-view/session telemetry.",
      source: sourceBreakdown || "No MCP results"
    },
    {
      label: "Source coverage",
      status: "MCP live",
      value: `${connectedSources.length}/${sources.length}`,
      detail: "How many configured MCP source systems are connected and contributing to the health model.",
      source: sources.map((source) => `${source.name}: ${source.status}`).join(", ")
    }
  ];
}

async function buildArticleInventory(resultsBySource) {
  const telemetry = loadPageViewTelemetry();
  const rawArticles = Object.entries(resultsBySource).flatMap(([sourceName, results]) =>
    results.map((result, index) => ({
      id: `${sourceName}-${index}`,
      title: result.title || "Untitled content",
      source: sourceName,
      url: result.contentUrl || result.url || result.link || "",
      excerpt: String(result.content || "").replace(/\s+/g, " ").slice(0, 260),
      repo: deriveRepo(sourceName, result.contentUrl || result.url || result.link || ""),
      result
    }))
  );

  const linkStates = await Promise.all(rawArticles.map((article) => checkUrlStatus(article.url)));
  return rawArticles.map((article, index) => {
    const quality = qualitySignalsForResult(article.result, article.source, linkStates[index]);
    const telemetryEntry = telemetry.get(article.url);
    const relevanceProxy = Math.max(10, 100 - index * 5);
    return {
      id: article.id,
      title: article.title,
      source: article.source,
      repo: article.repo,
      url: article.url,
      excerpt: article.excerpt,
      qualityScore: quality.score,
      freshness: quality.freshness,
      lastUpdated: quality.lastUpdated,
      state: quality.state,
      linkState: quality.linkState,
      metadata: quality.metadata,
      actionability: quality.actionability,
      pageViews: Number.isFinite(telemetryEntry?.pageViews) ? telemetryEntry.pageViews : null,
      pageViewScore: Number.isFinite(telemetryEntry?.pageViews) ? telemetryEntry.pageViews : relevanceProxy,
      pageViewDisplay: Number.isFinite(telemetryEntry?.pageViews) ? String(telemetryEntry.pageViews) : `${relevanceProxy} proxy`,
      pageViewSource: Number.isFinite(telemetryEntry?.pageViews) ? "Content Hub telemetry" : "MCP relevance proxy"
    };
  });
}

function buildRepoHealth(articleInventory) {
  const groups = new Map();
  for (const article of articleInventory) {
    const key = `${article.source}|${article.repo}`;
    if (!groups.has(key)) {
      groups.set(key, {
        source: article.source,
        repo: article.repo,
        articles: 0,
        qualityTotal: 0,
        fresh: 0,
        staleOrMissing: 0,
        brokenLinks: 0,
        states: new Map()
      });
    }

    const group = groups.get(key);
    group.articles += 1;
    group.qualityTotal += article.qualityScore;
    if (article.freshness === "Current") group.fresh += 1;
    if (article.freshness === "Missing" || article.freshness === "Stale") group.staleOrMissing += 1;
    if (article.linkState !== "OK") group.brokenLinks += 1;
    group.states.set(article.state, (group.states.get(article.state) || 0) + 1);
  }

  return Array.from(groups.values())
    .map((group) => {
      const qualityScore = Math.round(group.qualityTotal / Math.max(1, group.articles));
      const health = classify(qualityScore);
      const stateSummary = Array.from(group.states.entries())
        .map(([state, count]) => `${state}: ${count}`)
        .join(", ");
      return {
        source: group.source,
        repo: group.repo,
        articles: group.articles,
        qualityScore,
        status: health.status,
        className: health.className,
        fresh: group.fresh,
        staleOrMissing: group.staleOrMissing,
        brokenLinks: group.brokenLinks,
        stateSummary
      };
    })
    .sort((a, b) => b.articles - a.articles || b.qualityScore - a.qualityScore);
}

function buildTopQualityArticles(articleInventory) {
  return [...articleInventory]
    .sort((a, b) => b.qualityScore - a.qualityScore)
    .slice(0, 5);
}

async function collectSource(source, query) {
  if (!source.endpoint) {
    return {
      source,
      connected: false,
      authNeeded: false,
      error: "MCP endpoint not configured. Set CSS_WIKI_MCP_ENDPOINT and CSS_WIKI_MCP_TOOL.",
      results: []
    };
  }

  try {
    const tool = await discoverSearchTool(source);
    const result = await callMcp(source, "tools/call", {
      name: tool,
      arguments: { query }
    });

    return {
      source: { ...source, tool },
      connected: true,
      authNeeded: false,
      error: "",
      results: extractResults(result)
    };
  } catch (error) {
    return {
      source,
      connected: false,
      authNeeded: error.statusCode === 401,
      error: error.statusCode === 401 ? "Authorization required. Set the source token environment variable." : error.message,
      results: []
    };
  }
}

async function buildHealthPayload(query) {
  const requestedQuery =
    query ||
    "Microsoft 365 support known issues escalation troubleshooting customer support content";
  const collected = await Promise.all(SOURCE_CONFIGS.map((source) => collectSource(source, requestedQuery)));
  const resultsBySource = {};
  for (const item of collected) {
    resultsBySource[item.source.name] = item.results;
  }

  const duplicateCounts = findDuplicateCounts(resultsBySource);
  const sourceScores = {};
  const sources = collected.map((item) => {
    const duplicateCount = duplicateCounts[item.source.name] || 0;
    const score = sourceHealth(item.results, duplicateCount, item.connected);
    sourceScores[item.source.name] = score;
    const health = classify(score);
    return {
      name: item.source.name,
      status: item.connected ? health.status : item.authNeeded ? "Auth needed" : "Not connected",
      className: item.connected ? health.className : "danger",
      score,
      pages: item.results.length,
      stale: item.results.filter((result) => !/Last Updated:/i.test(result.content || "")).length,
      critical: score < 60 ? Math.max(1, Math.ceil(item.results.length / 3)) : Math.max(0, duplicateCount),
      sync: item.connected ? new Date().toLocaleTimeString() : item.error,
      endpoint: item.source.endpoint,
      tool: item.source.tool,
      connected: item.connected,
      authNeeded: item.authNeeded
    };
  });

  const allResults = Object.values(resultsBySource).flat();
  const connectedCount = sources.filter((source) => source.connected).length;
  const overallHealth = connectedCount
    ? Math.round(sources.filter((source) => source.connected).reduce((total, source) => total + source.score, 0) / connectedCount)
    : 0;
  const metadata = metadataCoverage(allResults);
  const actionability = actionabilityScore(allResults);
  const freshness = freshnessScore(allResults);
  const needsAction = sources.reduce((total, source) => total + source.stale + source.critical, 0);
  const articleInventory = await buildArticleInventory(resultsBySource);
  const repoHealth = buildRepoHealth(articleInventory);
  const topQualityArticles = buildTopQualityArticles(articleInventory);

  return {
    generatedAt: new Date().toISOString(),
    query: requestedQuery,
    metrics: {
      overallHealth,
      needsAction,
      freshness,
      connectorState: `${connectedCount}/${sources.length}`,
      metadata,
      actionability,
      articles: articleInventory.length,
      repos: repoHealth.length
    },
    sources,
    repoHealth,
    articleInventory,
    topQualityArticles,
    journeys: buildJourneySegments(allResults),
    mcpTrackedMetrics: buildMcpTrackedMetrics(allResults, sources, resultsBySource, freshness, metadata, actionability, needsAction),
    contentItems: buildContentItems(resultsBySource, sourceScores),
    contentHub: CONTENT_HUB_INSIGHTS,
    actions: [
      {
        label: "Route action to Rubik or Content Mentor",
        detail: "Use Rubik for article creation/PR submission and Content Mentor for assisted authoring, selection, and publishing workflows.",
        tag: "Action path"
      },
      {
        label: "Add Content Hub benchmarks",
        detail: "Track PR volume, CPM triage SLA, SME review coverage, page-view quality, cost avoidance, and content opportunities alongside MCP source health.",
        tag: "Metrics"
      },
      {
        label: "Connect gated sources",
        detail: "Evergreen and CSS Wiki require authorization or endpoint configuration before they can contribute to the model.",
        tag: connectedCount === sources.length ? "Done" : "Needed"
      },
      {
        label: "Review high-risk content",
        detail: "Prioritize rows marked Critical or High, especially pages missing Last Updated metadata.",
        tag: "Today"
      },
      {
        label: "Assign content owners",
        detail: "MCP search results do not expose owners, so ownership should be joined from your governance inventory.",
        tag: "This week"
      },
      {
        label: "Add source metadata",
        detail: "Freshness and owner coverage become stronger when LMC, SMC, Evergreen, and CSS Wiki expose review dates and owners.",
        tag: "Next sprint"
      }
    ]
  };
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    response.end();
    return;
  }

  if (request.method === "GET" && (requestUrl.pathname === "/" || requestUrl.pathname === "/dashboard")) {
    serveDashboard(response);
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/favicon.ico") {
    response.writeHead(204, { "Cache-Control": "max-age=86400" });
    response.end();
    return;
  }

  if (request.method === "GET" && requestUrl.pathname === "/api/health-data") {
    try {
      const payload = await buildHealthPayload(requestUrl.searchParams.get("query") || "");
      sendJson(response, 200, payload);
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
    return;
  }

  sendJson(response, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`CSS Content Health dashboard: http://127.0.0.1:${PORT}/`);
  console.log("Optional auth/config env vars:");
  console.log("  EVERGREEN_MCP_TOKEN, CSS_WIKI_MCP_ENDPOINT, CSS_WIKI_MCP_TOOL, CSS_WIKI_MCP_TOKEN");
});
