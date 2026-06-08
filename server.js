#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile, readdir, stat } from "node:fs/promises";
import { createReadStream, realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { promisify } from "node:util";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const execFileAsync = promisify(execFile);
const port = Number(process.env.PORT || 3817);
const host = process.env.HOST || "127.0.0.1";
const networkLabel = process.env.OPENCLAW_MONITOR_NETWORK_LABEL || "Private network";
const hostLabel = process.env.OPENCLAW_MONITOR_HOST_LABEL || os.hostname();
const analyticsWindowDays = Number(process.env.OPENCLAW_MONITOR_ANALYTICS_DAYS || 14);

const cronDir = expandHome(process.env.OPENCLAW_CRON_DIR || "~/.openclaw/cron");
const jobsPath = process.env.OPENCLAW_JOBS_PATH || path.join(cronDir, "jobs.json");
const statePath = process.env.OPENCLAW_STATE_PATH || deriveStatePath(jobsPath);
const runsDir = process.env.OPENCLAW_RUNS_DIR || path.join(cronDir, "runs");
const taskRunsPath = process.env.OPENCLAW_TASK_RUNS_PATH || path.join(path.dirname(cronDir), "tasks", "runs.sqlite");

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
  const analyticsWindowStart = Date.now() - analyticsWindowDays * 24 * 60 * 60 * 1000;
  const jobs = source.jobs.map((job) => normalizeJob(job, source.state));
  const resolvedTaskRunsPath = await resolveExistingPath(taskRunsPath);
  const taskRunsByJob = await loadTaskRunsForJobs(jobs.map((job) => job.id), 250, resolvedTaskRunsPath);
  const jobsWithRuns = await Promise.all(
    jobs.map(async (job) => {
      const runs = await loadRuns(job.id, 250, taskRunsByJob.get(job.id) || []);
      const lastRun = runs[0] || null;
      const analytics = jobAnalytics(job, runs, analyticsWindowStart);
      return {
        ...job,
        status: deriveJobStatus(job, source.state?.[job.id], lastRun),
        typicalDurationMs: typicalDurationMs(runs),
        lastRun,
        recentRuns: runs.slice(0, 8),
        analytics,
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
  const analytics = await buildOverviewAnalytics(jobsWithRuns, events, analyticsWindowStart);

  return {
    generatedAt: new Date().toISOString(),
    source: source.kind,
    paths: { jobsPath: source.paths?.jobsPath || jobsPath, statePath: source.paths?.statePath || statePath, runsDir, taskRunsPath: resolvedTaskRunsPath },
    host: hostLabel,
    networkLabel,
    jobs: jobsWithRuns,
    events,
    counts,
    analytics,
  };
}

async function loadOpenClawData() {
  try {
    const jobsRead = await readJsonResolved(jobsPath);
    const stateRead = await readJsonResolved(statePath).catch(() => ({ data: {}, path: statePath }));
    const jobsRaw = jobsRead.data;
    const stateRaw = stateRead.data;
    const jobs = extractJobs(jobsRaw);
    if (jobs.length > 0) {
      return { kind: "openclaw", jobs, state: normalizeStateMap(stateRaw), paths: { jobsPath: jobsRead.path, statePath: stateRead.path } };
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

export async function loadRuns(jobId, limit = 50, taskRuns = null) {
  const filePath = await resolveExistingPath(path.join(runsDir, `${jobId}.jsonl`));
  const taskBoardRuns = taskRuns || (await loadTaskRunsForJobs([jobId], limit)).get(jobId) || [];
  try {
    const text = await readFile(filePath, "utf8");
    return mergeRuns(parseRunLines(text, jobId), taskBoardRuns).slice(0, limit);
  } catch {
    return mergeRuns(taskBoardRuns, sampleRuns[jobId] || []).slice(0, limit);
  }
}

async function loadTaskRunsForJobs(jobIds, perJobLimit = 50, storePath = taskRunsPath) {
  const ids = [...new Set((jobIds || []).filter(Boolean).map(String))];
  if (!ids.length) return new Map();

  const resolvedPath = await resolveExistingPath(storePath);
  try {
    const info = await stat(resolvedPath);
    if (!info.isFile()) return new Map();
  } catch {
    return new Map();
  }

  const rowLimit = Math.max(ids.length, ids.length * Math.max(1, Number(perJobLimit) || 50));
  const sql = `
    select
      task_id, source_id, owner_key, agent_id, run_id, label, status, delivery_status,
      created_at, started_at, ended_at, last_event_at, error, progress_summary,
      terminal_summary, terminal_outcome, child_session_key
    from task_runs
    where source_id in (${ids.map(sqlString).join(",")})
    order by coalesce(ended_at, last_event_at, started_at, created_at) desc
    limit ${rowLimit};
  `;

  try {
    const { stdout } = await execFileAsync("sqlite3", ["-json", resolvedPath, sql], { timeout: 5000, maxBuffer: 5 * 1024 * 1024 });
    const rows = JSON.parse(stdout || "[]");
    const byJob = new Map();
    rows.forEach((row, index) => {
      const run = normalizeTaskRun(row, index);
      if (!run) return;
      const bucket = byJob.get(run.jobId) || [];
      if (bucket.length < perJobLimit) bucket.push(run);
      byJob.set(run.jobId, bucket);
    });
    return byJob;
  } catch {
    return new Map();
  }
}

function normalizeTaskRun(row, index) {
  if (!row?.source_id) return null;
  const startedAt = msToIso(row.started_at) || msToIso(row.created_at) || msToIso(row.last_event_at);
  const endedAt = msToIso(row.ended_at) || msToIso(row.last_event_at);
  const summary = row.terminal_summary || row.progress_summary || row.terminal_outcome || row.label || "";
  return {
    id: String(row.run_id || row.task_id || `${row.source_id}-task-${row.started_at || row.created_at || index}`),
    taskId: row.task_id || "",
    jobId: String(row.source_id),
    status: normalizeRunStatus(row.status || row.terminal_outcome),
    exitCode: null,
    startedAt,
    endedAt,
    durationMs: calculateDurationMs(startedAt, endedAt),
    summary,
    stdout: "",
    stderr: stringifyLog(row.error || ""),
    delivery: {},
    deliveryStatus: row.delivery_status || "",
    delivered: null,
    sessionKey: row.child_session_key || "",
    model: "",
    provider: "",
    usage: null,
    nextRunAt: null,
    raw: {
      task_id: row.task_id,
      source_id: row.source_id,
      run_id: row.run_id,
      label: row.label,
      status: row.status,
      delivery_status: row.delivery_status,
      created_at: row.created_at,
      started_at: row.started_at,
      ended_at: row.ended_at,
      last_event_at: row.last_event_at,
      terminal_outcome: row.terminal_outcome,
    },
  };
}

function mergeRuns(...runSets) {
  const seen = new Set();
  return runSets
    .flat()
    .filter(Boolean)
    .filter((run) => {
      const key = `${run.jobId || ""}|${run.startedAt || run.endedAt || ""}|${run.status || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => Date.parse(b.startedAt || b.endedAt || 0) - Date.parse(a.startedAt || a.endedAt || 0));
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
  const deliveryStatus = run.deliveryStatus || (run.delivered === true ? "delivered" : run.delivered === false ? "not-delivered" : "");
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
    deliveryStatus,
    delivered: run.delivered ?? run.delivery?.delivered ?? null,
    sessionKey: run.sessionKey || "",
    model: run.model || "",
    provider: run.provider || "",
    usage: normalizeUsage(run.usage),
    nextRunAt: msToIso(run.nextRunAtMs),
    raw: run,
  };
}

function normalizeRunStatus(status) {
  const normalized = String(status || "unknown").toLowerCase();
  if (["success", "ok", "completed", "complete"].includes(normalized)) return "succeeded";
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
      status: job.status || "unknown",
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

function jobAnalytics(job, runs, windowStartMs) {
  const windowRuns = runs.filter((run) => runTimeMs(run) >= windowStartMs);
  const successfulRuns = windowRuns.filter((run) => run.status === "succeeded");
  const failedRuns = windowRuns.filter((run) => run.status === "failed");
  const delivery = countBy(windowRuns, (run) => normalizeDeliveryBucket(run.deliveryStatus, job.delivery.mode));
  const durations = numericValues(windowRuns.map((run) => run.durationMs)).sort((a, b) => a - b);
  const usageRuns = windowRuns.filter((run) => run.usage?.totalTokens);
  const totalTokens = usageRuns.reduce((sum, run) => sum + Number(run.usage.totalTokens || 0), 0);
  const lastFailure = failedRuns[0] || null;
  const timeoutMs = Number(job.payload.timeoutSeconds) > 0 ? Number(job.payload.timeoutSeconds) * 1000 : null;
  const p90DurationMs = percentile(durations, 0.9);

  return {
    windowDays: analyticsWindowDays,
    runs: windowRuns.length,
    succeeded: successfulRuns.length,
    failed: failedRuns.length,
    successRate: windowRuns.length ? successfulRuns.length / windowRuns.length : null,
    recovered: failedRuns.length > 0 && windowRuns[0]?.status === "succeeded",
    noRuns: runs.length === 0,
    stale: isStaleJob(job, runs[0]),
    lastRunAt: runs[0]?.startedAt || null,
    lastFailureAt: lastFailure?.startedAt || null,
    lastFailureSummary: firstLine(lastFailure?.summary || lastFailure?.stderr || ""),
    delivery,
    durationMs: {
      p50: percentile(durations, 0.5),
      p90: p90DurationMs,
      p99: percentile(durations, 0.99),
      max: durations.length ? durations[durations.length - 1] : null,
    },
    usage: {
      runs: usageRuns.length,
      totalTokens,
      avgTokens: usageRuns.length ? Math.round(totalTokens / usageRuns.length) : null,
    },
    timeoutRisk: Boolean(timeoutMs && p90DurationMs && p90DurationMs > timeoutMs * 0.8),
  };
}

async function buildOverviewAnalytics(jobs, events, windowStartMs) {
  const failures = jobs
    .filter((job) => job.analytics.failed > 0)
    .sort((a, b) => b.analytics.failed - a.analytics.failed || Date.parse(b.analytics.lastFailureAt || 0) - Date.parse(a.analytics.lastFailureAt || 0));
  const recovered = jobs.filter((job) => job.analytics.recovered).sort((a, b) => Date.parse(b.analytics.lastFailureAt || 0) - Date.parse(a.analytics.lastFailureAt || 0));
  const noRuns = jobs.filter((job) => job.analytics.noRuns);
  const stale = jobs.filter((job) => job.analytics.stale);
  const deliveryProblems = jobs
    .map((job) => ({
      id: job.id,
      name: job.name,
      owner: ownerKey(job),
      notDelivered: job.analytics.delivery["not-delivered"] || 0,
      unknown: job.analytics.delivery.unknown || 0,
      delivered: job.analytics.delivery.delivered || 0,
      mode: job.delivery.mode,
    }))
    .filter((item) => item.notDelivered || item.unknown)
    .sort((a, b) => b.notDelivered - a.notDelivered || b.unknown - a.unknown);

  const durationRows = jobs
    .filter((job) => job.analytics.durationMs.p90)
    .map((job) => ({
      id: job.id,
      name: job.name,
      owner: ownerKey(job),
      p90Ms: job.analytics.durationMs.p90,
      maxMs: job.analytics.durationMs.max,
      timeoutRisk: job.analytics.timeoutRisk,
    }))
    .sort((a, b) => b.p90Ms - a.p90Ms);

  const usageRows = jobs
    .filter((job) => job.analytics.usage.totalTokens)
    .map((job) => ({
      id: job.id,
      name: job.name,
      owner: ownerKey(job),
      totalTokens: job.analytics.usage.totalTokens,
      avgTokens: job.analytics.usage.avgTokens,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const totalRuns = jobs.reduce((sum, job) => sum + job.analytics.runs, 0);
  const totalSucceeded = jobs.reduce((sum, job) => sum + job.analytics.succeeded, 0);
  const totalFailed = jobs.reduce((sum, job) => sum + job.analytics.failed, 0);
  const deliveryCounts = mergeCounts(jobs.map((job) => job.analytics.delivery));
  const durations = numericValues(jobs.flatMap((job) => [job.analytics.durationMs.p50, job.analytics.durationMs.p90, job.analytics.durationMs.p99, job.analytics.durationMs.max])).sort((a, b) => a - b);
  const totalTokens = jobs.reduce((sum, job) => sum + job.analytics.usage.totalTokens, 0);

  return {
    windowDays: analyticsWindowDays,
    totals: {
      runs: totalRuns,
      succeeded: totalSucceeded,
      failed: totalFailed,
      successRate: totalRuns ? totalSucceeded / totalRuns : null,
      totalTokens,
      avgTokens: totalRuns ? Math.round(totalTokens / totalRuns) : null,
      durationMs: {
        p50: percentile(durations, 0.5),
        p90: percentile(durations, 0.9),
        p99: percentile(durations, 0.99),
        max: durations.length ? durations[durations.length - 1] : null,
      },
    },
    delivery: deliveryCounts,
    owners: ownerAnalytics(jobs),
    reliability: {
      failures: failures.slice(0, 12).map(jobSummary),
      recovered: recovered.slice(0, 12).map(jobSummary),
      noRuns: noRuns.slice(0, 12).map(jobSummary),
      stale: stale.slice(0, 12).map(jobSummary),
    },
    deliveryProblems: deliveryProblems.slice(0, 12),
    durationOutliers: durationRows.slice(0, 12),
    usageOutliers: usageRows.slice(0, 12),
    schedule: scheduleAnalytics(events),
    archived: await archivedRunAnalytics(new Set(jobs.map((job) => job.id)), windowStartMs),
  };
}

function ownerAnalytics(jobs) {
  const owners = new Map();
  jobs.forEach((job) => {
    const key = ownerKey(job);
    if (!owners.has(key)) {
      owners.set(key, { key, label: ownerLabel(job), jobs: 0, runs: 0, failed: 0, recovered: 0, noRuns: 0, tokens: 0 });
    }
    const owner = owners.get(key);
    owner.jobs += 1;
    owner.runs += job.analytics.runs;
    owner.failed += job.analytics.failed;
    owner.recovered += job.analytics.recovered ? 1 : 0;
    owner.noRuns += job.analytics.noRuns ? 1 : 0;
    owner.tokens += job.analytics.usage.totalTokens;
  });
  return [...owners.values()].sort((a, b) => b.jobs - a.jobs || a.label.localeCompare(b.label));
}

function scheduleAnalytics(events) {
  const upcoming = events.filter((event) => event.kind !== "run" && event.startedAt);
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  const byDay = {};
  upcoming.forEach((event) => {
    const date = new Date(event.startedAt);
    byHour[date.getHours()].count += 1;
    const day = date.toISOString().slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
  });

  const closeStarts = [];
  const sorted = [...upcoming].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    const gapMinutes = (Date.parse(current.startedAt) - Date.parse(previous.startedAt)) / 60000;
    if (gapMinutes >= 0 && gapMinutes <= 5) {
      closeStarts.push({
        when: current.startedAt,
        gapMinutes: Math.round(gapMinutes),
        jobs: [previous.jobName, current.jobName],
      });
    }
  }

  return {
    upcoming: upcoming.length,
    byHour,
    byDay: Object.entries(byDay).map(([day, count]) => ({ day, count })),
    closeStarts: closeStarts.slice(0, 20),
  };
}

async function archivedRunAnalytics(currentJobIds, windowStartMs) {
  try {
    const files = (await readdir(runsDir)).filter((file) => /\.jsonl(?:\.migrated)?$/.test(file));
    const orphanIds = files.map((file) => file.replace(/\.jsonl(?:\.migrated)?$/, "")).filter((jobId) => !currentJobIds.has(jobId));
    const orphanFailures = [];
    for (const jobId of orphanIds.slice(0, 100)) {
      const runs = await loadRuns(jobId, 100);
      const failure = runs.find((run) => run.status === "failed" && runTimeMs(run) >= windowStartMs);
      if (failure) {
        orphanFailures.push({
          id: jobId,
          lastFailureAt: failure.startedAt,
          summary: firstLine(failure.summary || failure.stderr || ""),
        });
      }
    }
    orphanFailures.sort((a, b) => Date.parse(b.lastFailureAt || 0) - Date.parse(a.lastFailureAt || 0));
    return {
      runFiles: files.length,
      orphanRunFiles: orphanIds.length,
      orphanRecentFailures: orphanFailures.slice(0, 10),
    };
  } catch {
    return { runFiles: 0, orphanRunFiles: 0, orphanRecentFailures: [] };
  }
}

function jobSummary(job) {
  return {
    id: job.id,
    name: job.name,
    owner: ownerKey(job),
    status: job.status,
    runs: job.analytics.runs,
    failed: job.analytics.failed,
    successRate: job.analytics.successRate,
    lastRunAt: job.analytics.lastRunAt,
    lastFailureAt: job.analytics.lastFailureAt,
    lastFailureSummary: job.analytics.lastFailureSummary,
  };
}

function isStaleJob(job, lastRun) {
  if (!lastRun) return false;
  const lastRunMs = runTimeMs(lastRun);
  if (!lastRunMs) return false;
  return Date.now() - lastRunMs > expectedCadenceMs(job) * 2.5;
}

function expectedCadenceMs(job) {
  if (Number.isFinite(Number(job.schedule.everyMs)) && Number(job.schedule.everyMs) > 0) return Number(job.schedule.everyMs);
  const fields = String(job.schedule.expr || "").trim().split(/\s+/);
  if (fields.length !== 5) return 7 * 24 * 60 * 60 * 1000;
  if (fields[2] !== "*" || fields[3] !== "*") return 32 * 24 * 60 * 60 * 1000;
  if (fields[4] !== "*") return 7 * 24 * 60 * 60 * 1000;
  if (fields[1].includes(",") || fields[1].includes("/") || fields[0].includes("/")) return 4 * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

function ownerKey(job) {
  if (job.agentId) return `agent:${job.agentId}`;
  if (job.sessionTarget && job.sessionTarget !== "isolated") return `session:${job.sessionTarget}`;
  if (job.sessionKey && !String(job.sessionKey).startsWith("cron:")) return `session:${job.sessionKey}`;
  return "isolated";
}

function ownerLabel(job) {
  return ownerKey(job)
    .replace(/^agent:/, "Agent: ")
    .replace(/^session:/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  return {
    inputTokens: Number(usage.input_tokens || usage.inputTokens || 0),
    outputTokens: Number(usage.output_tokens || usage.outputTokens || 0),
    totalTokens: Number(usage.total_tokens || usage.totalTokens || 0),
  };
}

function normalizeDeliveryBucket(value, configuredMode = "") {
  const status = String(value || "").toLowerCase();
  if (status === "delivered") return "delivered";
  if (status === "not-delivered" || status === "failed" || status === "error") return "not-delivered";
  if (status === "not-requested" || configuredMode === "none" || !configuredMode) return "not-requested";
  return "unknown";
}

function runTimeMs(run) {
  const value = Date.parse(run?.startedAt || run?.endedAt || "");
  return Number.isFinite(value) ? value : 0;
}

function numericValues(values) {
  return values.map(Number).filter((value) => Number.isFinite(value) && value >= 0);
}

function percentile(sortedValues, ratio) {
  if (!sortedValues.length) return null;
  const index = Math.min(sortedValues.length - 1, Math.floor((sortedValues.length - 1) * ratio));
  return sortedValues[index];
}

function countBy(values, keyFn) {
  return values.reduce((counts, value) => {
    const key = keyFn(value) || "unknown";
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function mergeCounts(items) {
  return items.reduce((totals, counts) => {
    Object.entries(counts || {}).forEach(([key, value]) => {
      totals[key] = (totals[key] || 0) + Number(value || 0);
    });
    return totals;
  }, {});
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
          status: job.status || "unknown",
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

async function readJsonResolved(filePath) {
  const resolvedPath = await resolveExistingPath(filePath);
  return { data: await readJson(resolvedPath), path: resolvedPath };
}

async function resolveExistingPath(filePath) {
  const candidates = [filePath, `${filePath}.migrated`];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // Try the next compatible filename.
    }
  }
  return filePath;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
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

function firstLine(value) {
  return String(value || "").split(/\r?\n/).find(Boolean) || "";
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
      "github-sweep": { nextRunAt: isoAt(13, 30, 0), lastStatus: "running", running: true },
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
        schedule: { kind: "cron", expr: "30 9,13,17 * * 1-5", tz: "America/New_York", staggerMs: 120000 },
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
      startedAt: isoAt(13, 30, 0),
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
