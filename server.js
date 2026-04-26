#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { createReadStream, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.PORT || 3817);
const host = process.env.HOST || "127.0.0.1";
const networkLabel = process.env.OPENCLAW_MONITOR_NETWORK_LABEL || "Private network";
const hostLabel = process.env.OPENCLAW_MONITOR_HOST_LABEL || os.hostname();

const cronDir = expandHome(process.env.OPENCLAW_CRON_DIR || "~/.openclaw/cron");
const jobsPath = process.env.OPENCLAW_JOBS_PATH || path.join(cronDir, "jobs.json");
const statePath = process.env.OPENCLAW_STATE_PATH || deriveStatePath(jobsPath);
const runsDir = process.env.OPENCLAW_RUNS_DIR || path.join(cronDir, "runs");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  try {
    if (url.pathname === "/api/overview") {
      const overview = await loadOverview();
      sendJson(res, overview);
      return;
    }

    if (url.pathname.startsWith("/api/jobs/") && url.pathname.endsWith("/runs")) {
      const jobId = decodeURIComponent(url.pathname.split("/")[3] || "");
      const limit = Number(url.searchParams.get("limit") || 50);
      sendJson(res, await loadRuns(jobId, limit));
      return;
    }

    await serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    sendJson(res, { error: "Internal server error", detail: String(error?.message || error) }, 500);
  }
});

if (isDirectRun()) {
  startServer();
}

export function startServer() {
  server.listen(port, host, () => {
    console.log(`OpenClaw Cron Monitor running at http://${host}:${port}`);
    console.log(`Reading cron jobs from ${jobsPath}`);
  });
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

export async function loadOverview() {
  const source = await loadOpenClawData();
  const jobs = source.jobs.map((job) => normalizeJob(job, source.state));
  const jobsWithRuns = await Promise.all(
    jobs.map(async (job) => {
      const runs = await loadRuns(job.id, 20);
      const lastRun = runs[0] || null;
      return {
        ...job,
        status: deriveJobStatus(job, source.state?.[job.id], lastRun),
        typicalDurationMs: typicalDurationMs(runs),
        lastRun,
        recentRuns: runs.slice(0, 6),
      };
    }),
  );

  const events = jobsWithRuns.flatMap((job) => buildEvents(job));
  const counts = jobsWithRuns.reduce(
    (acc, job) => {
      acc.total += 1;
      acc[job.status] = (acc[job.status] || 0) + 1;
      return acc;
    },
    { total: 0, running: 0, succeeded: 0, failed: 0, warning: 0, skipped: 0, unknown: 0 },
  );

  return {
    generatedAt: new Date().toISOString(),
    source: source.kind,
    paths: { jobsPath, statePath, runsDir },
    host: hostLabel,
    networkLabel,
    jobs: jobsWithRuns,
    events,
    counts,
  };
}

async function loadOpenClawData() {
  try {
    const jobsRaw = await readJson(jobsPath);
    const stateRaw = await readJson(statePath).catch(() => ({}));
    const jobs = extractJobs(jobsRaw);
    if (jobs.length > 0) {
      return { kind: "openclaw", jobs, state: normalizeStateMap(stateRaw) };
    }
  } catch {
    // Fall through to sample data so the UI remains useful before OpenClaw is installed.
  }

  return sampleData();
}

function extractJobs(raw) {
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.jobs)) return raw.jobs;
  if (Array.isArray(raw?.items)) return raw.items;
  if (raw?.jobs && typeof raw.jobs === "object") return Object.values(raw.jobs);
  if (raw && typeof raw === "object") {
    const values = Object.values(raw).filter((value) => value && typeof value === "object");
    if (values.some((value) => value.schedule || value.payload || value.jobId || value.id)) return values;
  }
  return [];
}

function normalizeStateMap(raw) {
  if (!raw || typeof raw !== "object") return {};
  const source = raw.jobs && typeof raw.jobs === "object" ? raw.jobs : raw.state && typeof raw.state === "object" ? raw.state : raw;
  return Object.fromEntries(
    Object.entries(source).map(([jobId, value]) => {
      const nested = value?.state && typeof value.state === "object" ? value.state : value;
      return [jobId, nested || {}];
    }),
  );
}

function normalizeJob(job, stateMap) {
  const id = String(job.jobId || job.id || job.name || "unknown-job");
  const state = stateMap?.[id] || {};
  const schedule = job.schedule || {};
  const payload = job.payload || {};
  const delivery = job.delivery || {};
  const sessionTarget = job.sessionTarget || job.session || "unknown";

  return {
    id,
    name: job.name || id,
    enabled: job.enabled !== false && job.disabled !== true,
    schedule: {
      kind: schedule.kind || inferScheduleKind(job, schedule),
      expr: schedule.expr || schedule.cron || job.cron || "",
      everyMs: schedule.everyMs || schedule.intervalMs || job.everyMs || null,
      at: schedule.at || job.at || null,
      tz: schedule.tz || job.tz || Intl.DateTimeFormat().resolvedOptions().timeZone,
      staggerMs: schedule.staggerMs ?? null,
    },
    sessionTarget,
    sessionKey: sessionTarget === "isolated" ? `cron:${id}` : sessionTarget,
    wakeMode: job.wakeMode || job.wake || "next-heartbeat",
    payload: {
      kind: payload.kind || (sessionTarget === "isolated" ? "agentTurn" : "systemEvent"),
      message: payload.message || payload.text || job.message || job.systemEvent || "",
      model: payload.model || job.model || "",
      thinking: payload.thinking || job.thinking || "",
      timeoutSeconds: payload.timeoutSeconds ?? job.timeoutSeconds ?? null,
      lightContext: payload.lightContext ?? job.lightContext ?? null,
      tools: payload.tools || job.tools || [],
    },
    delivery: {
      mode: delivery.mode || (job.notify ? "webhook" : job.announce ? "announce" : "none"),
      channel: delivery.channel || job.channel || "",
      to: delivery.to || job.to || "",
      failureDestination: delivery.failureDestination || "",
    },
    agentId: job.agentId || job.agent || "",
    state,
    nextRunAt: state.nextRunAt || state.nextAt || state.next || msToIso(state.nextRunAtMs) || job.nextRunAt || null,
    raw: job,
  };
}

function inferScheduleKind(job, schedule) {
  if (schedule.at || job.at) return "at";
  if (schedule.everyMs || job.everyMs) return "every";
  return "cron";
}

function deriveJobStatus(job, state, lastRun) {
  if (!job.enabled) return "unknown";
  if (state?.running || state?.activeRunId || state?.status === "running") return "running";
  const status = String(lastRun?.status || state?.lastRunStatus || state?.lastStatus || "").toLowerCase();
  if (["succeeded", "success", "ok", "completed"].includes(status)) return "succeeded";
  if (["failed", "error", "timed_out", "cancelled", "lost"].includes(status)) return "failed";
  if (["warning", "retrying", "queued"].includes(status)) return "warning";
  if (["skipped"].includes(status)) return "skipped";
  return "unknown";
}

export async function loadRuns(jobId, limit = 50) {
  const filePath = path.join(runsDir, `${jobId}.jsonl`);
  try {
    const text = await readFile(filePath, "utf8");
    return parseRunLines(text, jobId).slice(0, limit);
  } catch {
    return sampleRuns[jobId]?.slice(0, limit) || [];
  }
}

function parseRunLines(text, jobId) {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return normalizeRun(JSON.parse(line), jobId, index);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.startedAt || b.endedAt || 0) - Date.parse(a.startedAt || a.endedAt || 0));
}

function normalizeRun(run, jobId, index) {
  const startedAt = run.startedAt || run.startTime || run.createdAt || run.enqueuedAt || run.at || msToIso(run.runAtMs) || msToIso(run.ts) || null;
  const endedAt = run.endedAt || run.endTime || run.completedAt || msToIso(addMs(run.runAtMs, run.durationMs)) || null;
  const durationMs = run.durationMs || calculateDurationMs(startedAt, endedAt);
  const stableTime = run.runAtMs || run.ts || Date.parse(startedAt || "") || index;
  return {
    id: String(run.runId || run.id || `${jobId}-${stableTime}`),
    taskId: run.taskId || run.task?.id || "",
    jobId,
    status: normalizeRunStatus(run.status || run.outcome || run.result?.status),
    exitCode: run.exitCode ?? run.result?.exitCode ?? null,
    startedAt,
    endedAt,
    durationMs,
    summary: run.summary || run.final || run.result?.summary || run.message || "",
    stdout: run.stdout || run.logs?.stdout || run.result?.stdout || "",
    stderr: stringifyLog(run.stderr || run.logs?.stderr || run.error || run.result?.stderr || ""),
    delivery: run.delivery || {},
    deliveryStatus: run.deliveryStatus || "",
    sessionKey: run.sessionKey || "",
    model: run.model || "",
    provider: run.provider || "",
    nextRunAt: msToIso(run.nextRunAtMs),
    raw: run,
  };
}

function normalizeRunStatus(status) {
  const normalized = String(status || "unknown").toLowerCase();
  if (["success", "ok", "completed"].includes(normalized)) return "succeeded";
  if (["error"].includes(normalized)) return "failed";
  return normalized;
}

function calculateDurationMs(startedAt, endedAt) {
  if (!startedAt || !endedAt) return null;
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function buildEvents(job) {
  const runEvents = job.recentRuns.map((run) => ({
    id: run.id,
    jobId: job.id,
    jobName: job.name,
    status: run.status,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: run.durationMs,
    kind: "run",
  }));

  const scheduledEvents = projectScheduledEvents(job);
  if (!scheduledEvents.length && job.nextRunAt) {
    scheduledEvents.push({
      id: `${job.id}-next`,
      jobId: job.id,
      jobName: job.name,
      status: "unknown",
      startedAt: job.nextRunAt,
      endedAt: null,
      durationMs: job.typicalDurationMs,
      kind: "next",
    });
  }

  return [...runEvents, ...scheduledEvents].filter((event) => event.startedAt);
}

function typicalDurationMs(runs) {
  const durations = runs
    .map((run) => Number(run.durationMs))
    .filter((duration) => Number.isFinite(duration) && duration > 0)
    .sort((a, b) => a - b);
  if (!durations.length) return null;
  return durations[Math.floor(durations.length / 2)];
}

function projectScheduledEvents(job) {
  if (!job.enabled || job.schedule.kind !== "cron" || !job.schedule.expr) return [];
  const cron = parseCronExpression(job.schedule.expr);
  if (!cron) return [];

  const now = new Date();
  const weekStart = startOfWeek(now);
  const windowStart = new Date(Math.max(now.getTime(), weekStart.getTime()));
  const windowEnd = new Date(weekStart);
  windowEnd.setDate(windowEnd.getDate() + 14);

  const events = [];
  const cursor = new Date(windowStart);
  cursor.setSeconds(0, 0);
  for (let day = new Date(cursor); day < windowEnd; day.setDate(day.getDate() + 1)) {
    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        const candidate = new Date(day);
        candidate.setHours(hour, minute, 0, 0);
        if (candidate < windowStart || candidate >= windowEnd) continue;
        if (!cron.months.has(candidate.getMonth() + 1)) continue;
        if (!cronDayMatches(cron, candidate)) continue;
        events.push({
          id: `${job.id}-scheduled-${candidate.getTime()}`,
          jobId: job.id,
          jobName: job.name,
          status: "unknown",
          startedAt: candidate.toISOString(),
          endedAt: null,
          durationMs: job.typicalDurationMs,
          kind: "scheduled",
        });
      }
    }
  }

  return events;
}

function startOfWeek(date) {
  const start = new Date(date);
  start.setDate(start.getDate() - start.getDay());
  start.setHours(0, 0, 0, 0);
  return start;
}

function cronDayMatches(cron, date) {
  const dayOfMonth = date.getDate();
  const dayOfWeek = date.getDay();
  const domWildcard = cron.domWildcard;
  const dowWildcard = cron.dowWildcard;
  const domMatches = cron.daysOfMonth.has(dayOfMonth);
  const dowMatches = cron.daysOfWeek.has(dayOfWeek);

  if (!domWildcard && !dowWildcard) return domMatches || dowMatches;
  if (!domWildcard) return domMatches;
  if (!dowWildcard) return dowMatches;
  return true;
}

function parseCronExpression(expr) {
  const fields = String(expr || "").trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minutes = parseCronField(fields[0], 0, 59);
  const hours = parseCronField(fields[1], 0, 23);
  const daysOfMonth = parseCronField(fields[2], 1, 31);
  const months = parseCronField(fields[3], 1, 12, monthNames());
  const daysOfWeek = parseCronField(fields[4], 0, 7, dayNames());
  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return null;
  if (daysOfWeek.has(7)) {
    daysOfWeek.add(0);
    daysOfWeek.delete(7);
  }
  return {
    minutes: [...minutes].sort((a, b) => a - b),
    hours: [...hours].sort((a, b) => a - b),
    daysOfMonth,
    months,
    daysOfWeek,
    domWildcard: fields[2] === "*",
    dowWildcard: fields[4] === "*",
  };
}

function parseCronField(field, min, max, aliases = {}) {
  const values = new Set();
  for (const rawPart of String(field || "").toLowerCase().split(",")) {
    const part = rawPart.trim();
    if (!part) return null;
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) return null;

    let start;
    let end;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [startRaw, endRaw] = rangePart.split("-");
      start = cronValue(startRaw, aliases);
      end = cronValue(endRaw, aliases);
    } else {
      start = cronValue(rangePart, aliases);
      end = start;
    }

    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) return null;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values.size ? values : null;
}

function cronValue(value, aliases) {
  return aliases[value] ?? Number(value);
}

function monthNames() {
  return { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
}

function dayNames() {
  return { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
}

async function serveStatic(requestPath, res) {
  const cleanPath = requestPath === "/" ? "/index.html" : requestPath;
  const filePath = path.normalize(path.join(publicDir, cleanPath));
  if (!filePath.startsWith(publicDir)) {
    sendText(res, "Forbidden", 403);
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a file");
    res.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
    createReadStream(filePath).pipe(res);
  } catch {
    sendText(res, "Not found", 404);
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value, null, 2));
}

function sendText(res, text, status = 200) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function deriveStatePath(storePath) {
  return storePath.endsWith(".json") ? storePath.replace(/\.json$/, "-state.json") : `${storePath}-state.json`;
}

function msToIso(value) {
  if (!Number.isFinite(Number(value))) return null;
  return new Date(Number(value)).toISOString();
}

function addMs(value, duration) {
  if (!Number.isFinite(Number(value)) || !Number.isFinite(Number(duration))) return null;
  return Number(value) + Number(duration);
}

function stringifyLog(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isoAt(hour, minute, dayOffset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

function sampleData() {
  return {
    kind: "sample",
    state: {
      "morning-brief": { nextRunAt: isoAt(7, 0, 1), lastStatus: "succeeded" },
      "github-sweep": { nextRunAt: isoAt(9, 30, 0), lastStatus: "running", running: true },
      "photos-backup": { nextRunAt: isoAt(2, 0, 1), lastStatus: "failed" },
    },
    jobs: [
      {
        jobId: "morning-brief",
        name: "Morning Brief",
        schedule: { kind: "cron", expr: "0 7 * * *", tz: "America/New_York", staggerMs: 0 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: {
          kind: "agentTurn",
          message: "Summarize overnight updates.",
          model: "openai/gpt-5.4-mini",
          thinking: "high",
          lightContext: false,
          tools: ["exec", "read"],
        },
        delivery: { mode: "announce", channel: "team-chat", to: "ops-notifications" },
      },
      {
        jobId: "github-sweep",
        name: "GitHub Sweep",
        schedule: { kind: "cron", expr: "*/30 * * * *", tz: "America/New_York", staggerMs: 120000 },
        sessionTarget: "session:github-ops",
        payload: {
          kind: "agentTurn",
          message: "Check GitHub notifications and summarize actionable PRs.",
          model: "openai/gpt-5.4",
          thinking: "medium",
          lightContext: true,
          tools: ["github", "read"],
        },
        delivery: { mode: "none" },
      },
      {
        jobId: "photos-backup",
        name: "Backup Photos",
        schedule: { kind: "cron", expr: "0 2 * * *", tz: "America/New_York" },
        sessionTarget: "isolated",
        payload: {
          kind: "agentTurn",
          message: "Copy new photo imports to network storage and report failures.",
          model: "openai/gpt-5.4-mini",
          thinking: "high",
          lightContext: false,
          tools: ["exec", "read"],
        },
        delivery: { mode: "announce", channel: "team-chat", to: "ops-notifications", failureDestination: "primary announce target" },
      },
    ],
  };
}

const sampleRuns = {
  "morning-brief": [
    {
      id: "run_8f42",
      taskId: "task_19c",
      jobId: "morning-brief",
      status: "succeeded",
      exitCode: 0,
      startedAt: isoAt(7, 0, 0),
      endedAt: isoAt(7, 4, 0),
      durationMs: 240000,
      summary: "Delivered the overnight brief to the notification target with calendar, email, and repo highlights.",
      stdout: "Posted summary to ops-notifications",
      stderr: "",
    },
  ],
  "github-sweep": [
    {
      id: "run_d381",
      taskId: "task_2ad",
      jobId: "github-sweep",
      status: "running",
      exitCode: null,
      startedAt: isoAt(9, 30, 0),
      endedAt: null,
      durationMs: null,
      summary: "Scanning GitHub notifications.",
      stdout: "Fetching pull requests...",
      stderr: "",
    },
  ],
  "photos-backup": [
    {
      id: "run_91ab",
      taskId: "task_42f",
      jobId: "photos-backup",
      status: "failed",
      exitCode: 1,
      startedAt: isoAt(2, 0, 0),
      endedAt: isoAt(2, 8, 0),
      durationMs: 522000,
      summary: "The photo backup could not reach the storage target.",
      stdout: "Scanning ~/Pictures/Imports\nFound 112 candidate files",
      stderr: "rsync: connection timed out\nnetwork route unavailable",
    },
    {
      id: "run_73af",
      taskId: "task_33d",
      jobId: "photos-backup",
      status: "succeeded",
      exitCode: 0,
      startedAt: isoAt(2, 0, -1),
      endedAt: isoAt(2, 44, -1),
      durationMs: 2652000,
      summary: "Copied 181 files to the backup target.",
      stdout: "rsync complete",
      stderr: "",
    },
    {
      id: "run_60bc",
      taskId: "task_29a",
      jobId: "photos-backup",
      status: "succeeded",
      exitCode: 0,
      startedAt: isoAt(2, 0, -2),
      endedAt: isoAt(2, 43, -2),
      durationMs: 2638000,
      summary: "Copied 176 files to the backup target.",
      stdout: "rsync complete",
      stderr: "",
    },
  ],
};
