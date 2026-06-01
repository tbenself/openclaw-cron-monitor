const app = document.querySelector("#app");

let data = null;
let selectedJobId = null;
let selectedTab = "summary";
let selectedRunId = null;
let searchTerm = "";
let statusFilter = "all";
let ownerFilter = "all";
let viewMode = "week";
let logStream = "stderr";

init();

async function init() {
  data = await fetch("/api/overview").then((response) => response.json());
  recordLocalUsage("visits");
  selectedJobId = data.jobs.find((job) => job.status === "failed")?.id || data.jobs[0]?.id || null;
  selectedRunId = selectedJob()?.lastRun?.id || null;
  setDefaultLogStream();
  render();
  window.setInterval(refresh, 30000);
}

async function refresh() {
  data = await fetch("/api/overview").then((response) => response.json());
  if (!selectedJob()) selectedJobId = data.jobs[0]?.id || null;
  if (!selectedRun(selectedJob())) selectedRunId = selectedJob()?.lastRun?.id || null;
  render();
}

function render() {
  const focus = captureFocus();
  const job = selectedJob();
  const visibleJobs = filteredJobs();
  const visibleJobIds = new Set(visibleJobs.map((item) => item.id));
  const visibleEvents = data.events.filter((event) => visibleJobIds.has(event.jobId));
  app.innerHTML = `
    <div class="shell">
      ${renderTopbar()}
      <div class="content">
        ${renderSidebar()}
        <main class="main">
          <div class="calendar-header">
            <div>
              <div class="calendar-title">${viewMode === "insights" ? "Cron insights" : "Cron calendar"}</div>
              <div class="copy">${data.source === "openclaw" ? "Live OpenClaw data" : "Sample data until OpenClaw cron files are present"}</div>
            </div>
            <div class="segmented" aria-label="Calendar view">
              ${["week", "today", "runs", "insights"].map((mode) => `<button class="segment ${viewMode === mode ? "active" : ""}" data-view="${mode}">${titleCase(mode)}</button>`).join("")}
            </div>
          </div>
          <div class="calendar-wrap">
            ${viewMode === "runs" ? renderRunsView(visibleJobs) : viewMode === "insights" ? renderInsightsView(visibleJobs, visibleEvents) : renderCalendar(visibleEvents)}
            ${job ? renderPopover(job) : '<div class="empty">No cron jobs found.</div>'}
          </div>
        </main>
      </div>
    </div>
  `;
  bindEvents();
  restoreFocus(focus);
}

function renderTopbar() {
  return `
    <header class="topbar">
      <button class="brand-button" data-action="home">OpenClaw Cron Monitor</button>
      <span class="status-line"><span class="dot succeeded"></span>${escapeHtml(data.networkLabel || "Private network")}</span>
      <span class="status-line">Host: ${escapeHtml(data.host)}</span>
      <span class="status-line">Updated ${escapeHtml(formatClock(data.generatedAt))}</span>
      <div class="toolbar">
        <input class="search" data-search placeholder="Search jobs or runs" value="${escapeAttr(searchTerm)}" />
        <button class="button" data-action="refresh">Refresh</button>
      </div>
    </header>
  `;
}

function renderSidebar() {
  const scoped = scopedJobs();
  const counts = countStatuses(scoped);
  return `
    <aside class="sidebar">
      <h3 class="section-title">Health</h3>
      <div class="health-grid">
        ${healthRow("All", "all", counts.total)}
        ${healthRow("Running", "running", counts.running)}
        ${healthRow("Succeeded", "succeeded", counts.succeeded)}
        ${healthRow("Failed", "failed", counts.failed)}
        ${healthRow("Skipped", "skipped", counts.skipped)}
        ${healthRow("Unknown", "unknown", counts.unknown)}
      </div>
      <div class="sidebar-block">
        <h3 class="section-title">Owner / Session</h3>
        <div class="owner-list">
          ${ownerFilters().map(renderOwnerRow).join("")}
        </div>
      </div>
      <div class="sidebar-block">
        <h3 class="section-title">Jobs</h3>
        <div class="job-list">
          ${filteredJobs().map(renderJobRow).join("") || '<div class="empty">No matching jobs.</div>'}
        </div>
      </div>
      <div class="sidebar-block">
        <h3 class="section-title">Source</h3>
        <div class="copy">${escapeHtml(data.paths.jobsPath)}</div>
      </div>
    </aside>
  `;
}

function renderOwnerRow(owner) {
  return `
    <button class="owner-row ${ownerFilter === owner.key ? "selected" : ""}" data-owner-filter="${escapeAttr(owner.key)}">
      <span class="owner-main">
        <span class="dot ${owner.status}"></span>
        <span>
          <span class="owner-name">${escapeHtml(owner.label)}</span>
          <span class="owner-subtitle">${escapeHtml(owner.detail)}</span>
        </span>
      </span>
      <span class="count">${owner.count}</span>
    </button>
  `;
}

function healthRow(label, status, count) {
  return `
    <button class="health-row ${statusFilter === status ? "selected" : ""}" data-status-filter="${status}">
      <span class="health-name"><span class="dot ${status}"></span>${label}</span>
      <span class="count">${count || 0}</span>
    </button>
  `;
}

function renderJobRow(job) {
  const owner = jobOwner(job);
  const flags = jobFlags(job);
  return `
    <button class="job-row ${job.id === selectedJobId ? "selected" : ""}" data-job-id="${escapeAttr(job.id)}">
      <span>
        <span class="job-name"><span class="dot ${job.status}"></span>${escapeHtml(job.name)}</span>
        <span class="job-subtitle">${escapeHtml(formatSchedule(job.schedule))} · ${escapeHtml(owner.label)}</span>
        ${flags.length ? `<span class="job-flags">${flags.map((flag) => `<span class="mini-flag ${flag.tone}">${escapeHtml(flag.label)}</span>`).join("")}</span>` : ""}
      </span>
      <span class="pill ${job.status}">${escapeHtml(job.status)}</span>
    </button>
  `;
}

function renderCalendar(events) {
  const days = viewMode === "today" ? [today()] : weekDays();
  const hours = Array.from({ length: 24 }, (_, index) => index);
  const modeClass = viewMode === "today" ? "today-calendar" : "week-calendar";
  return `
    <section class="calendar ${modeClass}">
      <div class="days">
        <div></div>
        ${days.map((day) => `
          <div class="day-head">
            <div class="day-name">${day.toLocaleDateString([], { weekday: "short" })}</div>
            <div class="day-date">${day.toLocaleDateString([], { month: "short", day: "numeric" })}</div>
          </div>
        `).join("")}
      </div>
      <div class="grid">
        <div class="time-col">
          ${hours.map((hour) => `<div class="time-label">${formatHour(hour)}</div>`).join("")}
        </div>
        ${days.map((day) => {
          const dayEvents = layoutEvents(events.filter((event) => isSameDay(event.startedAt, day)));
          return `
          <div class="day-col">
            ${dayEvents.map((event) => renderEvent(event)).join("")}
          </div>
        `;
        }).join("")}
      </div>
    </section>
  `;
}

function renderRunsView(jobs) {
  const rows = jobs
    .flatMap((job) => job.recentRuns.map((run) => ({ job, run })))
    .sort((a, b) => Date.parse(b.run.startedAt || 0) - Date.parse(a.run.startedAt || 0))
    .slice(0, 120);

  return `
    <section class="runs-view">
      <div class="runs-head">
        <span>Run</span>
        <span>Status</span>
        <span>Started</span>
        <span>Duration</span>
        <span>Delivery</span>
      </div>
      ${rows.map(({ job, run }) => `
        <button class="runs-row" data-job-id="${escapeAttr(job.id)}" data-run-id="${escapeAttr(run.id)}">
          <span>
            <strong>${escapeHtml(job.name)}</strong>
            <small>${escapeHtml(run.id)}</small>
          </span>
          <span><span class="pill ${run.status}">${escapeHtml(titleCase(run.status))}</span></span>
          <span>${escapeHtml(formatDateTime(run.startedAt))}</span>
          <span>${escapeHtml(formatDuration(run.durationMs))}</span>
          <span>${escapeHtml(formatDeliveryStatus(run, job))}</span>
        </button>
      `).join("") || '<div class="empty">No runs match the current filters.</div>'}
    </section>
  `;
}

function renderInsightsView(jobs, events) {
  const insights = scopedInsights(jobs, events);
  return `
    <section class="insights-view">
      <div class="insight-kpis">
        ${kpiCard("14d success", formatPercent(insights.successRate), `${insights.failed} failed / ${insights.runs} runs`, insights.failed ? "failed" : "succeeded")}
        ${kpiCard("Delivery gaps", formatNumber(insights.notDelivered), `${formatNumber(insights.delivered)} delivered`, insights.notDelivered ? "warning" : "succeeded")}
        ${kpiCard("P90 runtime", formatDuration(insights.durationMs.p90), `max ${formatDuration(insights.durationMs.max)}`, insights.durationMs.p90 && insights.durationMs.p90 > 10 * 60 * 1000 ? "warning" : "succeeded")}
        ${kpiCard("Token use", formatTokens(insights.totalTokens), `${formatTokens(insights.avgTokens)} avg/run`, "unknown")}
        ${kpiCard("Schedule load", formatNumber(insights.schedule.upcoming), `${insights.schedule.closeStarts.length} close starts`, insights.schedule.closeStarts.length ? "warning" : "succeeded")}
      </div>
      <div class="insight-grid">
        ${insightPanel("Owner Cockpits", renderOwnerInsights(insights.owners))}
        ${insightPanel("Reliability Watch", renderReliabilityRows(insights))}
        ${insightPanel("Delivery Audit", renderDeliveryRows(insights.deliveryProblems))}
        ${insightPanel("Schedule Heatmap", renderScheduleHeatmap(insights.schedule))}
        ${insightPanel("Runtime Outliers", renderRuntimeRows(insights.durationOutliers))}
        ${insightPanel("Token Outliers", renderUsageRows(insights.usageOutliers))}
        ${insightPanel("Archived History", renderArchivedRows(data.analytics?.archived))}
        ${insightPanel("Local UI Activity", renderLocalUsage())}
      </div>
    </section>
  `;
}

function kpiCard(label, value, detail, tone) {
  return `
    <div class="kpi-card ${tone}">
      <span class="kpi-label">${escapeHtml(label)}</span>
      <span class="kpi-value">${escapeHtml(value)}</span>
      <span class="kpi-detail">${escapeHtml(detail)}</span>
    </div>
  `;
}

function insightPanel(title, body) {
  return `
    <section class="insight-panel">
      <div class="panel-title">${escapeHtml(title)}</div>
      ${body}
    </section>
  `;
}

function renderOwnerInsights(owners) {
  if (!owners.length) return '<div class="empty compact">No owners in this scope.</div>';
  return `
    <div class="insight-list">
      ${owners.map((owner) => `
        <button class="insight-row" data-owner-filter="${escapeAttr(owner.key)}">
          <span>
            <span class="insight-main">${escapeHtml(owner.label)}</span>
            <span class="insight-sub">${owner.jobs} jobs · ${owner.runs} runs · ${owner.failed} failed</span>
          </span>
          <span class="pill ${owner.failed ? "failed" : owner.noRuns ? "unknown" : "succeeded"}">${escapeHtml(formatTokens(owner.tokens))}</span>
        </button>
      `).join("")}
    </div>
  `;
}

function renderReliabilityRows(insights) {
  const rows = [
    ...insights.failures.map((job) => ({ job, tone: "failed", detail: `${job.analytics.failed} failures · last ${formatDateTime(job.analytics.lastFailureAt)}` })),
    ...insights.recovered.map((job) => ({ job, tone: "warning", detail: `Recovered after ${job.analytics.failed} recent failure${job.analytics.failed === 1 ? "" : "s"}` })),
    ...insights.noRuns.map((job) => ({ job, tone: "unknown", detail: "No recorded run history" })),
    ...insights.stale.map((job) => ({ job, tone: "warning", detail: `Last run ${formatDateTime(job.analytics.lastRunAt)}` })),
  ];
  if (!rows.length) return '<div class="empty compact">No reliability warnings in this scope.</div>';
  return `
    <div class="insight-list">
      ${rows.slice(0, 12).map(({ job, tone, detail }) => renderInsightJobRow(job, detail, tone)).join("")}
    </div>
  `;
}

function renderDeliveryRows(rows) {
  if (!rows.length) return '<div class="empty compact">No delivery gaps in this scope.</div>';
  return `
    <div class="insight-list">
      ${rows.slice(0, 12).map(({ job, notDelivered, unknown, delivered }) => renderInsightJobRow(job, `${notDelivered} not delivered · ${unknown} unknown · ${delivered} delivered`, notDelivered ? "failed" : "warning")).join("")}
    </div>
  `;
}

function renderScheduleHeatmap(schedule) {
  const max = Math.max(1, ...schedule.byHour.map((item) => item.count));
  return `
    <div class="hour-bars">
      ${schedule.byHour.map((item) => `
        <div class="hour-bar" title="${formatHour(item.hour)} ${item.count} projected starts">
          <span style="height:${Math.max(4, Math.round((item.count / max) * 54))}px"></span>
          <small>${item.hour}</small>
        </div>
      `).join("")}
    </div>
    <div class="insight-list tight">
      ${schedule.closeStarts.slice(0, 6).map((item) => `
        <div class="insight-row static">
          <span>
            <span class="insight-main">${escapeHtml(formatDateTime(item.when))}</span>
            <span class="insight-sub">${escapeHtml(item.jobs.join(" / "))}</span>
          </span>
          <span class="pill warning">${item.gapMinutes}m</span>
        </div>
      `).join("") || '<div class="empty compact">No close starts in this scope.</div>'}
    </div>
  `;
}

function renderRuntimeRows(rows) {
  if (!rows.length) return '<div class="empty compact">No runtime data in this scope.</div>';
  return `
    <div class="insight-list">
      ${rows.slice(0, 10).map(({ job, p90Ms, maxMs, timeoutRisk }) => renderInsightJobRow(job, `p90 ${formatDuration(p90Ms)} · max ${formatDuration(maxMs)}`, timeoutRisk ? "failed" : "warning")).join("")}
    </div>
  `;
}

function renderUsageRows(rows) {
  if (!rows.length) return '<div class="empty compact">No token usage data in this scope.</div>';
  return `
    <div class="insight-list">
      ${rows.slice(0, 10).map(({ job, totalTokens, avgTokens }) => renderInsightJobRow(job, `${formatTokens(totalTokens)} total · ${formatTokens(avgTokens)} avg`, "unknown")).join("")}
    </div>
  `;
}

function renderArchivedRows(archived) {
  if (!archived) return '<div class="empty compact">No archived run data available.</div>';
  return `
    <div class="archive-summary">
      <span>${formatNumber(archived.runFiles)} run files</span>
      <span>${formatNumber(archived.orphanRunFiles)} orphan histories</span>
    </div>
    <div class="insight-list tight">
      ${(archived.orphanRecentFailures || []).slice(0, 5).map((item) => `
        <div class="insight-row static">
          <span>
            <span class="insight-main">${escapeHtml(item.id)}</span>
            <span class="insight-sub">${escapeHtml(item.summary || "Recent failure in archived job")}</span>
          </span>
          <span class="pill failed">${escapeHtml(formatDateTime(item.lastFailureAt))}</span>
        </div>
      `).join("") || '<div class="empty compact">No recent orphan failures.</div>'}
    </div>
  `;
}

function renderLocalUsage() {
  const usage = localUsage();
  return `
    <div class="usage-grid">
      ${[
        ["Visits", usage.visits],
        ["Job opens", usage.jobOpens],
        ["Filter changes", usage.filterChanges],
        ["View changes", usage.viewChanges],
        ["Search edits", usage.searchEdits],
        ["Refreshes", usage.refreshes],
      ].map(([label, value]) => `
        <div class="usage-cell">
          <span>${escapeHtml(label)}</span>
          <strong>${formatNumber(value || 0)}</strong>
        </div>
      `).join("")}
    </div>
  `;
}

function renderInsightJobRow(job, detail, tone) {
  return `
    <button class="insight-row" data-job-id="${escapeAttr(job.id)}">
      <span>
        <span class="insight-main"><span class="dot ${job.status}"></span>${escapeHtml(job.name)}</span>
        <span class="insight-sub">${escapeHtml(detail)}</span>
      </span>
      <span class="pill ${tone}">${escapeHtml(jobOwner(job).label)}</span>
    </button>
  `;
}

function renderEvent(event) {
  const date = new Date(event.startedAt);
  const top = Math.max(0, date.getHours() * 60 + date.getMinutes());
  const height = Math.max(34, Math.min(140, Math.round((event.durationMs || 20 * 60000) / 60000)));
  const selected = event.jobId === selectedJobId && (!selectedRunId || event.id === selectedRunId);
  const left = event.layout ? event.layout.left : 7;
  const width = event.layout ? event.layout.width : "calc(100% - 14px)";
  return `
    <button class="event ${event.status} ${selected ? "selected" : ""}" style="top:${top}px;height:${height}px;left:${left};right:auto;width:${width}" data-job-id="${escapeAttr(event.jobId)}" data-run-id="${escapeAttr(event.id)}">
      <span class="event-title"><span class="dot ${event.status}"></span>${escapeHtml(event.jobName)}</span>
      <span class="event-time">${formatTime(event.startedAt)} · ${event.kind === "run" ? formatDuration(event.durationMs) : "scheduled"}</span>
    </button>
  `;
}

function renderPopover(job) {
  const run = selectedRun(job);
  const runStatus = run?.status || job.status;
  const tabs = ["summary", "metrics", "steps", "openclaw", "logs", "history", "raw"];
  return `
    <aside class="popover">
      <div class="popover-head">
        <span class="dot ${runStatus}" style="margin-top:6px"></span>
        <div class="popover-title">
          <h2>${escapeHtml(job.name)}</h2>
          <div class="popover-subtitle">${escapeHtml(formatSchedule(job.schedule))}</div>
        </div>
        <div class="head-actions">
          <button class="icon-button" title="Open full run" data-action="raw">↗</button>
          <button class="icon-button" title="Close" data-action="close">×</button>
        </div>
      </div>
      <div class="popover-body">
        <div class="facts">
          <div class="fact"><div class="fact-label">Run status</div><div class="fact-value"><span class="pill ${runStatus}">${escapeHtml(titleCase(runStatus))}</span></div></div>
          <div class="fact"><div class="fact-label">Run ID</div><div class="fact-value">${escapeHtml(run?.id || "No runs")}</div></div>
          <div class="fact"><div class="fact-label">Task ID</div><div class="fact-value">${escapeHtml(run?.taskId || "Unknown")}</div></div>
          <div class="fact"><div class="fact-label">Started</div><div class="fact-value">${escapeHtml(formatDateTime(run?.startedAt))}</div></div>
          <div class="fact"><div class="fact-label">Duration</div><div class="fact-value">${escapeHtml(formatDuration(run?.durationMs))}</div></div>
          <div class="fact"><div class="fact-label">Next run</div><div class="fact-value">${escapeHtml(formatDateTime(job.nextRunAt))}</div></div>
        </div>
        <div class="segmented tabs">
          ${tabs.map((tab) => `<button class="segment ${selectedTab === tab ? "active" : ""}" data-tab="${tab}">${tabLabel(tab)}</button>`).join("")}
        </div>
        ${renderTab(job, run)}
      </div>
    </aside>
  `;
}

function renderTab(job, run) {
  if (selectedTab === "summary") {
    const diagnosis = summarizeRun(job, run);
    const runStatus = run?.status || job.status;
    return `
      <div class="tab-panel">
        <section class="summary-block ${runStatus}">
          <div class="summary-kicker">${escapeHtml(titleCase(runStatus))}</div>
          <div class="summary-title">${escapeHtml(diagnosis.headline)}</div>
          <div class="summary-copy">${escapeHtml(diagnosis.detail)}</div>
        </section>
        ${renderMetaGrid([
          ["Likely cause", diagnosis.cause],
          ["Last successful run", formatDateTime(job.recentRuns.find((item) => item.status === "succeeded")?.startedAt)],
          ["Owner / session", jobOwner(job).label],
          ["14d reliability", formatReliability(job)],
          ["Recent delivery", formatDeliveryCounts(job.analytics?.delivery)],
          ["Delivery", formatDeliveryStatus(run, job)],
          ["Reports", formatDelivery(job)],
          ["Timeout", formatTimeout(job.payload.timeoutSeconds)],
          ["Failure route", job.delivery.failureDestination || fallbackFailureRoute(job)],
          ["Host", data.host],
        ])}
      </div>
    `;
  }

  if (selectedTab === "metrics") {
    return `
      <div class="tab-panel">
        <div class="metric-strip">
          ${kpiCard("14d success", formatPercent(job.analytics?.successRate), `${job.analytics?.failed || 0} failed / ${job.analytics?.runs || 0} runs`, job.analytics?.failed ? "failed" : "succeeded")}
          ${kpiCard("P90 runtime", formatDuration(job.analytics?.durationMs?.p90), `max ${formatDuration(job.analytics?.durationMs?.max)}`, job.analytics?.timeoutRisk ? "failed" : "unknown")}
          ${kpiCard("Token use", formatTokens(job.analytics?.usage?.totalTokens), `${formatTokens(job.analytics?.usage?.avgTokens)} avg`, "unknown")}
        </div>
        ${renderMetaGrid([
          ["Recovered failure", job.analytics?.recovered ? "yes" : "no"],
          ["No run history", job.analytics?.noRuns ? "yes" : "no"],
          ["Stale cadence", job.analytics?.stale ? "yes" : "no"],
          ["Last failure", formatDateTime(job.analytics?.lastFailureAt)],
          ["Last failure summary", job.analytics?.lastFailureSummary || "None recorded"],
          ["Delivery counts", formatDeliveryCounts(job.analytics?.delivery)],
          ["Timeout risk", job.analytics?.timeoutRisk ? "p90 is near timeout" : "not flagged"],
        ])}
      </div>
    `;
  }

  if (selectedTab === "steps") {
    const steps = extractSteps(job);
    return `
      <div class="tab-panel">
        <div>
          <div class="panel-title">What this job does</div>
          <div class="copy">${escapeHtml(steps.purpose)}</div>
        </div>
        <div>
          <div class="panel-title">How it works</div>
          <ol class="step-list">
            ${steps.items.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}
          </ol>
        </div>
        ${renderMetaGrid([
          ["Schedule", `${formatSchedule(job.schedule)} · ${job.schedule.tz || "host time"}`],
          ["Owner / session", jobOwner(job).label],
          ["Session", `${job.sessionTarget} · ${job.sessionKey}`],
          ["Payload", job.payload.kind],
          ["Timeout", formatTimeout(job.payload.timeoutSeconds)],
          ["Reports", formatDelivery(job)],
          ["Model", job.payload.model || "Agent/default"],
        ])}
      </div>
    `;
  }

  if (selectedTab === "openclaw") {
    return `
      <div class="tab-panel">
        <div>
          <div class="panel-title">How this job runs</div>
          <div class="copy">Gateway scheduler execution. Each run creates a background task and writes to the OpenClaw cron run log.</div>
        </div>
        ${renderMetaGrid([
          ["Owner / session", jobOwner(job).label],
          ["Session", `${job.sessionTarget} · ${job.sessionKey}`],
          ["Payload", job.payload.kind],
          ["Reports", formatDelivery(job)],
          ["Failure route", job.delivery.failureDestination || fallbackFailureRoute(job)],
          ["Model", job.payload.model || "Agent/default"],
          ["Thinking", job.payload.thinking || "Default"],
          ["Timeout", formatTimeout(job.payload.timeoutSeconds)],
          ["Context", job.payload.lightContext === true ? "light-context on" : job.payload.lightContext === false ? "light-context off" : "default"],
          ["Tools", Array.isArray(job.payload.tools) && job.payload.tools.length ? job.payload.tools.join(", ") : "Default"],
          ["Schedule", `${formatSchedule(job.schedule)} · TZ ${job.schedule.tz || "host"}`],
          ["Stagger", job.schedule.staggerMs === null ? "auto/default" : `${job.schedule.staggerMs} ms`],
          ["State store", "jobs-state.json"],
          ["Run log", `cron/runs/${job.id}.jsonl`],
        ])}
        <div>
          <div class="panel-title">Message</div>
          <pre class="message-box">${escapeHtml(job.payload.message || "No payload message recorded.")}</pre>
        </div>
      </div>
    `;
  }

  if (selectedTab === "logs") {
    const stderr = run?.stderr || "";
    const stdout = run?.stdout || "";
    const output = logStream === "stdout" ? stdout : stderr;
    return `
      <div class="tab-panel">
        <div class="segmented">
          <button class="segment ${logStream === "stderr" ? "active" : ""}" data-log-stream="stderr">stderr</button>
          <button class="segment ${logStream === "stdout" ? "active" : ""}" data-log-stream="stdout">stdout</button>
        </div>
        <pre class="log-box ${logStream === "stderr" && stderr ? "error" : ""}">${escapeHtml(output || `No ${logStream} output recorded for this run.`)}</pre>
      </div>
    `;
  }

  if (selectedTab === "raw") {
    const raw = run?.raw ? JSON.stringify(run.raw, null, 2) : JSON.stringify(job.raw, null, 2);
    return `
      <div class="tab-panel">
        <div>
          <div class="panel-title">Raw ${run?.raw ? "run" : "job"} record</div>
          <div class="copy">Read-only OpenClaw data as recorded on disk.</div>
        </div>
        <pre class="log-box">${escapeHtml(raw || "No raw record available.")}</pre>
      </div>
    `;
  }

  return `
    <div class="tab-panel">
      <div class="panel-title">Previous Runs</div>
      <div class="history-list">
        ${job.recentRuns.length ? job.recentRuns.map((item) => `
          <button class="history-row" data-run-id="${escapeAttr(item.id)}">
            <span class="history-main">
              <span class="dot ${item.status}"></span>
              <span>
                <span class="history-time">${escapeHtml(formatDateTime(item.startedAt))}</span>
                <span class="history-sub">${escapeHtml(item.id)} · ${escapeHtml(formatDuration(item.durationMs))}</span>
              </span>
            </span>
            <span class="pill ${item.status}">${escapeHtml(item.status)}</span>
          </button>
        `).join("") : '<div class="empty">No previous runs recorded.</div>'}
      </div>
    </div>
  `;
}

function renderMetaGrid(rows) {
  return `
    <div class="meta-grid">
      ${rows.map(([key, value]) => `
        <div class="meta-row">
          <span class="meta-key">${escapeHtml(key)}</span>
          <span class="meta-value">${escapeHtml(value || "Unknown")}</span>
        </div>
      `).join("")}
    </div>
  `;
}

function bindEvents() {
  document.querySelector('[data-action="home"]')?.addEventListener("click", () => {
    recordLocalUsage("homeClicks");
    searchTerm = "";
    statusFilter = "all";
    ownerFilter = "all";
    viewMode = "week";
    selectedTab = "summary";
    selectedJobId = data.jobs.find((job) => job.status === "failed")?.id || data.jobs[0]?.id || null;
    selectedRunId = selectedJob()?.lastRun?.id || null;
    setDefaultLogStream();
    render();
  });
  document.querySelector('[data-action="refresh"]')?.addEventListener("click", () => {
    recordLocalUsage("refreshes");
    refresh();
  });
  document.querySelector('[data-action="raw"]')?.addEventListener("click", () => {
    selectedTab = "raw";
    render();
  });
  document.querySelector('[data-action="close"]')?.addEventListener("click", () => {
    selectedJobId = filteredJobs()[0]?.id || null;
    selectedRunId = selectedJob()?.lastRun?.id || null;
    render();
  });
  document.querySelectorAll("[data-view]").forEach((element) => {
    element.addEventListener("click", () => {
      recordLocalUsage("viewChanges");
      viewMode = element.dataset.view || "week";
      render();
    });
  });
  document.querySelectorAll("[data-log-stream]").forEach((element) => {
    element.addEventListener("click", () => {
      logStream = element.dataset.logStream || "stderr";
      render();
    });
  });
  document.querySelector("[data-search]")?.addEventListener("input", (event) => {
    recordLocalUsage("searchEdits");
    searchTerm = event.target.value;
    keepSelectionVisible();
    render();
  });
  document.querySelectorAll("[data-status-filter]").forEach((element) => {
    element.addEventListener("click", () => {
      recordLocalUsage("filterChanges");
      statusFilter = element.dataset.statusFilter || "all";
      keepSelectionVisible();
      render();
    });
  });
  document.querySelectorAll("[data-owner-filter]").forEach((element) => {
    element.addEventListener("click", () => {
      recordLocalUsage("filterChanges");
      ownerFilter = element.dataset.ownerFilter || "all";
      statusFilter = "all";
      keepSelectionVisible();
      render();
    });
  });
  document.querySelectorAll("[data-job-id]").forEach((element) => {
    element.addEventListener("click", () => {
      recordLocalUsage("jobOpens");
      selectedJobId = element.dataset.jobId;
      selectedRunId = element.dataset.runId || selectedJob()?.lastRun?.id || null;
      selectedTab = "summary";
      setDefaultLogStream();
      render();
    });
  });
  document.querySelectorAll("[data-tab]").forEach((element) => {
    element.addEventListener("click", () => {
      recordLocalUsage("tabChanges");
      selectedTab = element.dataset.tab;
      render();
    });
  });
  document.querySelectorAll("[data-run-id]").forEach((element) => {
    element.addEventListener("click", () => {
      selectedRunId = element.dataset.runId;
      setDefaultLogStream();
      render();
    });
  });
}

function selectedJob() {
  return data?.jobs.find((job) => job.id === selectedJobId) || null;
}

function selectedRun(job) {
  if (!job) return null;
  const recordedRun = job.recentRuns.find((run) => run.id === selectedRunId);
  if (recordedRun) return recordedRun;
  const projectedEvent = data?.events.find((event) => event.jobId === job.id && event.id === selectedRunId && event.kind !== "run");
  if (projectedEvent) {
    return {
      id: projectedEvent.id,
      taskId: "",
      jobId: job.id,
      status: projectedEvent.status,
      startedAt: projectedEvent.startedAt,
      endedAt: null,
      durationMs: projectedEvent.durationMs,
      summary: "Scheduled occurrence. No run output has been recorded yet.",
      stdout: "",
      stderr: "",
      deliveryStatus: "not-requested",
      kind: projectedEvent.kind,
      raw: projectedEvent,
    };
  }
  return job.lastRun || null;
}

function setDefaultLogStream() {
  const run = selectedRun(selectedJob());
  logStream = run?.stderr ? "stderr" : "stdout";
}

function summarizeRun(job, run) {
  if (!run) {
    return {
      headline: "No run has been recorded yet.",
      detail: "OpenClaw knows about this job, but there is no run history for the selected window.",
      cause: "Waiting for first recorded run",
    };
  }

  if (run.kind === "scheduled" || run.kind === "next") {
    return {
      headline: "This occurrence is scheduled.",
      detail: "OpenClaw has not run this occurrence yet. The status will update when a matching run is written to the cron run log.",
      cause: "Waiting for scheduled time",
    };
  }

  const status = run.status || job.status;
  if (status === "failed") {
    const error = firstLine(run.stderr) || firstLine(run.summary);
    return {
      headline: "The selected run failed.",
      detail: error || "OpenClaw recorded a failed run without a detailed error message.",
      cause: deriveCause(run),
    };
  }

  if (status === "running") {
    return {
      headline: "The job is currently running.",
      detail: run.summary || "OpenClaw has not written a final result for this run yet.",
      cause: "In progress",
    };
  }

  if (status === "succeeded") {
    return {
      headline: "The selected run completed successfully.",
      detail: run.summary || "OpenClaw recorded a successful run without a narrative summary.",
      cause: "No issue recorded",
    };
  }

  if (status === "skipped") {
    return {
      headline: "The selected run was skipped.",
      detail: run.summary || "OpenClaw skipped this execution.",
      cause: firstLine(run.stderr) || "Skip condition",
    };
  }

  return {
    headline: "OpenClaw has limited status information for this run.",
    detail: run.summary || "Use History, Logs, or Raw to inspect the underlying record.",
    cause: firstLine(run.stderr) || "Unknown",
  };
}

function deriveCause(run) {
  const text = `${run?.stderr || ""}\n${run?.summary || ""}\n${run?.deliveryStatus || ""}`.toLowerCase();
  if (text.includes("timed out") || text.includes("timeout")) return "Run timed out";
  if (text.includes("requires target")) return "Delivery target missing";
  if (text.includes("not-delivered")) return "Delivery did not complete";
  if (text.includes("permission")) return "Permission or access problem";
  if (text.includes("network") || text.includes("connection")) return "Network or connection problem";
  return firstLine(run?.stderr) || "OpenClaw reported failure";
}

function extractSteps(job) {
  const message = job.payload.message || "";
  const instruction = firstUsefulLine(message) || "Run the configured OpenClaw payload.";
  const explicitSteps = message
    .split(/\r?\n/)
    .map((line) => cleanupStep(line))
    .filter((line) => line && /^(?:[-*]|\d+[.)]|step\s+\d+|run |check |review |fetch |sync |summarize |deliver |update )/i.test(line))
    .map((line) => line.replace(/^[-*\d.)\s]+/, "").trim())
    .slice(0, 5);

  const usableSteps = explicitSteps.filter((step) => !isConstraintLine(step));
  const items = usableSteps.length >= 3 ? usableSteps : [
    `Trigger from ${formatSchedule(job.schedule)} in ${job.schedule.tz || "host time"}.`,
    `Start ${job.sessionTarget || "default"} session ${job.sessionKey || ""}.`.trim(),
    `Run payload instruction: ${truncate(instruction, 150)}`,
    `User report: ${formatDelivery(job)}.`,
    `Record status and run output in cron/runs/${job.id}.jsonl.`,
  ];

  return {
    purpose: truncate(instruction, 240),
    items,
  };
}

function firstUsefulLine(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => cleanupStep(line))
    .find((line) => line && !/^rules?:$/i.test(line) && !/^critical output contract:?$/i.test(line) && !isConstraintLine(line));
}

function cleanupStep(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^#+\s*/, "")
    .trim();
}

function truncate(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function isConstraintLine(value) {
  return /^(do not|don't|stay silent|no reply|no notification|critical|rules?:|if stdout|if stderr|final answer)/i.test(String(value || "").trim());
}

function scopedInsights(jobs, events) {
  const runs = jobs.reduce((sum, job) => sum + (job.analytics?.runs || 0), 0);
  const succeeded = jobs.reduce((sum, job) => sum + (job.analytics?.succeeded || 0), 0);
  const failed = jobs.reduce((sum, job) => sum + (job.analytics?.failed || 0), 0);
  const delivered = jobs.reduce((sum, job) => sum + (job.analytics?.delivery?.delivered || 0), 0);
  const notDelivered = jobs.reduce((sum, job) => sum + (job.analytics?.delivery?.["not-delivered"] || 0), 0);
  const durations = jobs.flatMap((job) => [job.analytics?.durationMs?.p50, job.analytics?.durationMs?.p90, job.analytics?.durationMs?.p99, job.analytics?.durationMs?.max]).map(Number).filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const totalTokens = jobs.reduce((sum, job) => sum + (job.analytics?.usage?.totalTokens || 0), 0);
  const failures = jobs.filter((job) => job.analytics?.failed > 0).sort((a, b) => b.analytics.failed - a.analytics.failed);
  const recovered = jobs.filter((job) => job.analytics?.recovered);
  const noRuns = jobs.filter((job) => job.analytics?.noRuns);
  const stale = jobs.filter((job) => job.analytics?.stale);
  const deliveryProblems = jobs
    .map((job) => ({
      job,
      notDelivered: job.analytics?.delivery?.["not-delivered"] || 0,
      unknown: job.analytics?.delivery?.unknown || 0,
      delivered: job.analytics?.delivery?.delivered || 0,
    }))
    .filter((item) => item.notDelivered || item.unknown)
    .sort((a, b) => b.notDelivered - a.notDelivered || b.unknown - a.unknown);
  const durationOutliers = jobs
    .filter((job) => job.analytics?.durationMs?.p90)
    .map((job) => ({ job, p90Ms: job.analytics.durationMs.p90, maxMs: job.analytics.durationMs.max, timeoutRisk: job.analytics.timeoutRisk }))
    .sort((a, b) => b.p90Ms - a.p90Ms);
  const usageOutliers = jobs
    .filter((job) => job.analytics?.usage?.totalTokens)
    .map((job) => ({ job, totalTokens: job.analytics.usage.totalTokens, avgTokens: job.analytics.usage.avgTokens }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    runs,
    succeeded,
    failed,
    successRate: runs ? succeeded / runs : null,
    delivered,
    notDelivered,
    durationMs: {
      p90: percentile(durations, 0.9),
      max: durations.length ? durations[durations.length - 1] : null,
    },
    totalTokens,
    avgTokens: runs ? Math.round(totalTokens / runs) : null,
    owners: scopedOwnerInsights(jobs),
    failures,
    recovered,
    noRuns,
    stale,
    deliveryProblems,
    durationOutliers,
    usageOutliers,
    schedule: scopedScheduleInsights(events),
  };
}

function scopedOwnerInsights(jobs) {
  const owners = new Map();
  jobs.forEach((job) => {
    const owner = jobOwner(job);
    if (!owners.has(owner.key)) {
      owners.set(owner.key, { key: owner.key, label: owner.label, jobs: 0, runs: 0, failed: 0, recovered: 0, noRuns: 0, tokens: 0 });
    }
    const row = owners.get(owner.key);
    row.jobs += 1;
    row.runs += job.analytics?.runs || 0;
    row.failed += job.analytics?.failed || 0;
    row.recovered += job.analytics?.recovered ? 1 : 0;
    row.noRuns += job.analytics?.noRuns ? 1 : 0;
    row.tokens += job.analytics?.usage?.totalTokens || 0;
  });
  return [...owners.values()].sort((a, b) => b.jobs - a.jobs || a.label.localeCompare(b.label));
}

function scopedScheduleInsights(events) {
  const upcoming = events.filter((event) => event.kind !== "run" && event.startedAt);
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  upcoming.forEach((event) => {
    byHour[new Date(event.startedAt).getHours()].count += 1;
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
  return { upcoming: upcoming.length, byHour, closeStarts };
}

function jobFlags(job) {
  const flags = [];
  if (job.analytics?.failed) flags.push({ label: `${job.analytics.failed} recent fail`, tone: "failed" });
  if (job.analytics?.recovered) flags.push({ label: "recovered", tone: "warning" });
  if (job.analytics?.noRuns) flags.push({ label: "no runs", tone: "unknown" });
  if (job.analytics?.stale) flags.push({ label: "stale", tone: "warning" });
  if (job.analytics?.timeoutRisk) flags.push({ label: "timeout risk", tone: "failed" });
  return flags.slice(0, 3);
}

function deliveryBucket(run, job) {
  const status = String(run?.deliveryStatus || "").toLowerCase();
  if (status === "delivered") return "delivered";
  if (status === "not-delivered" || status === "failed" || status === "error") return "not-delivered";
  if (status === "not-requested" || job?.delivery?.mode === "none") return "not-requested";
  return status ? "unknown" : "not-requested";
}

function filteredJobs() {
  return scopedJobs().filter((job) => statusFilter === "all" || job.status === statusFilter);
}

function scopedJobs() {
  const query = searchTerm.trim().toLowerCase();
  return data.jobs.filter((job) => {
    const owner = jobOwner(job);
    const matchesOwner = ownerFilter === "all" || owner.key === ownerFilter;
    const haystack = [
      job.name,
      job.id,
      owner.label,
      owner.key,
      job.schedule?.expr,
      job.schedule?.tz,
      job.sessionTarget,
      job.sessionKey,
      job.agentId,
      job.payload?.message,
      job.delivery?.mode,
      job.delivery?.channel,
      job.delivery?.to,
      job.analytics?.lastFailureSummary,
      job.analytics?.failed ? "recent failure recovered reliability" : "",
      job.analytics?.noRuns ? "no runs never run" : "",
      job.analytics?.stale ? "stale cadence" : "",
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return matchesOwner && (!query || haystack.includes(query));
  });
}

function ownerFilters() {
  const groups = new Map();
  data.jobs.forEach((job) => {
    const owner = jobOwner(job);
    if (!groups.has(owner.key)) {
      groups.set(owner.key, { key: owner.key, label: owner.label, jobs: [] });
    }
    groups.get(owner.key).jobs.push(job);
  });

  const owners = [...groups.values()]
    .map((owner) => ({ ...owner, ...ownerSummary(owner.jobs) }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  return [
    {
      key: "all",
      label: "All owners",
      ...ownerSummary(data.jobs),
    },
    ...owners,
  ];
}

function ownerSummary(jobs) {
  const counts = countStatuses(jobs);
  const status = counts.failed ? "failed" : counts.running ? "running" : counts.unknown ? "unknown" : counts.succeeded ? "succeeded" : "skipped";
  const detailParts = [`${counts.total} ${pluralize("job", counts.total)}`];
  if (counts.failed) detailParts.push(`${counts.failed} failed`);
  if (counts.running) detailParts.push(`${counts.running} running`);
  return {
    count: counts.total,
    status,
    detail: detailParts.join(" · "),
  };
}

function countStatuses(jobs) {
  return jobs.reduce(
    (counts, job) => {
      const status = job.status || "unknown";
      counts.total += 1;
      counts[status] = (counts[status] || 0) + 1;
      return counts;
    },
    { total: 0, running: 0, succeeded: 0, failed: 0, skipped: 0, unknown: 0 },
  );
}

function jobOwner(job) {
  if (job.agentId) {
    return { key: `agent:${job.agentId}`, label: `Agent: ${cleanOwnerLabel(job.agentId)}` };
  }

  if (job.sessionTarget && job.sessionTarget !== "isolated") {
    return { key: `session:${job.sessionTarget}`, label: cleanOwnerLabel(job.sessionTarget) };
  }

  if (job.sessionKey && !String(job.sessionKey).startsWith("cron:")) {
    return { key: `session:${job.sessionKey}`, label: cleanOwnerLabel(job.sessionKey) };
  }

  return { key: "isolated", label: "Isolated cron" };
}

function cleanOwnerLabel(value) {
  const label = String(value || "Unknown")
    .replace(/^session:/, "")
    .replace(/^agent:/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return label
    .split(/\s+/)
    .map((word) => word ? word.charAt(0).toUpperCase() + word.slice(1) : word)
    .join(" ");
}

function pluralize(word, count) {
  return count === 1 ? word : `${word}s`;
}

function keepSelectionVisible() {
  const jobs = filteredJobs();
  if (!jobs.some((job) => job.id === selectedJobId)) {
    selectedJobId = jobs[0]?.id || data.jobs[0]?.id || null;
    selectedRunId = selectedJob()?.lastRun?.id || null;
  }
}

function captureFocus() {
  const active = document.activeElement;
  if (!active?.matches?.("[data-search]")) return null;
  return {
    target: "search",
    start: active.selectionStart,
    end: active.selectionEnd,
  };
}

function restoreFocus(focus) {
  if (focus?.target !== "search") return;
  const input = document.querySelector("[data-search]");
  if (!input) return;
  input.focus({ preventScroll: true });
  if (Number.isInteger(focus.start) && Number.isInteger(focus.end)) {
    input.setSelectionRange(focus.start, focus.end);
  }
}

function layoutEvents(events) {
  const sorted = [...events].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const active = [];
  return sorted.map((event) => {
    const start = minutesSinceDayStart(event.startedAt);
    const end = start + Math.max(20, Math.round((event.durationMs || 20 * 60000) / 60000));
    for (let index = active.length - 1; index >= 0; index -= 1) {
      if (active[index].end <= start) active.splice(index, 1);
    }

    const used = new Set(active.map((item) => item.lane));
    let lane = 0;
    while (used.has(lane)) lane += 1;
    active.push({ lane, end });
    const laneCount = Math.max(1, Math.min(4, Math.max(lane + 1, active.length)));
    const laneWidth = 100 / laneCount;
    const visibleLane = Math.min(lane, 3);
    const width = `calc(${laneWidth}% - 10px)`;
    const left = `calc(${laneWidth * visibleLane}% + 7px)`;
    return { ...event, layout: { left, width } };
  });
}

function minutesSinceDayStart(value) {
  const date = new Date(value);
  return date.getHours() * 60 + date.getMinutes();
}

function weekDays() {
  const today = new Date();
  const start = new Date(today);
  start.setDate(today.getDate() - today.getDay());
  start.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return day;
  });
}

function today() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function isSameDay(value, date) {
  const item = new Date(value);
  return item.getFullYear() === date.getFullYear() && item.getMonth() === date.getMonth() && item.getDate() === date.getDate();
}

function formatReliability(job) {
  if (!job.analytics) return "Unknown";
  if (!job.analytics.runs) return "No runs in window";
  return `${formatPercent(job.analytics.successRate)} · ${job.analytics.failed || 0} failed / ${job.analytics.runs} runs`;
}

function formatDeliveryCounts(delivery = {}) {
  const parts = [
    ["delivered", delivery.delivered],
    ["not delivered", delivery["not-delivered"]],
    ["not requested", delivery["not-requested"]],
    ["unknown", delivery.unknown],
  ].filter(([, value]) => value);
  return parts.length ? parts.map(([label, value]) => `${value} ${label}`).join(" · ") : "No delivery records";
}

function formatPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "n/a";
  return `${Math.round(Number(value) * 100)}%`;
}

function formatNumber(value) {
  const number = Number(value || 0);
  return number.toLocaleString();
}

function formatTokens(value) {
  const number = Number(value || 0);
  if (!number) return "0";
  if (number >= 1000000) return `${(number / 1000000).toFixed(number >= 10000000 ? 0 : 1)}M`;
  if (number >= 1000) return `${(number / 1000).toFixed(number >= 10000 ? 0 : 1)}k`;
  return String(Math.round(number));
}

function percentile(sortedValues, ratio) {
  if (!sortedValues.length) return null;
  const index = Math.min(sortedValues.length - 1, Math.floor((sortedValues.length - 1) * ratio));
  return sortedValues[index];
}

function formatSchedule(schedule) {
  if (!schedule) return "No schedule";
  if (schedule.kind === "at") return schedule.at || "one-shot";
  if (schedule.kind === "every") return `every ${formatDuration(schedule.everyMs)}`;
  return schedule.expr || "cron";
}

function formatHour(hour) {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  return date.toLocaleTimeString([], { hour: "numeric" });
}

function formatTime(value) {
  if (!value) return "Unknown";
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatDateTime(value) {
  if (!value) return "Unknown";
  return new Date(value).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
}

function formatClock(value) {
  if (!value) return "Unknown";
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return "Unknown";
  if (Number(ms) > 0 && Number(ms) < 60000) return "<1m";
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function formatTimeout(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return "default";
  return formatDuration(value * 1000);
}

function fallbackFailureRoute(job) {
  if (job.delivery.mode === "announce") return "primary announce target";
  if (job.delivery.mode === "webhook") return "webhook";
  return "none configured";
}

function formatDeliveryStatus(run, job) {
  const value = run?.deliveryStatus || job.delivery.mode || "none";
  return value === "not-requested" || value === "none" ? "not requested" : value;
}

function formatDelivery(job) {
  const mode = job.delivery.mode || "none";
  const route = [job.delivery.channel, job.delivery.to].filter(Boolean).join(" to ");
  if (mode === "none") {
    return route ? `not requested (${route} configured)` : "not requested";
  }
  const channel = job.delivery.channel ? ` via ${job.delivery.channel}` : "";
  const target = job.delivery.to ? ` to ${job.delivery.to}` : "";
  return `${mode}${channel}${target}`;
}

function titleCase(value) {
  return String(value || "").replace(/^\w/, (letter) => letter.toUpperCase());
}

function tabLabel(value) {
  return value === "openclaw" ? "OpenClaw" : titleCase(value);
}

function firstLine(value) {
  return String(value || "").split(/\r?\n/).find(Boolean) || "";
}

function localUsage() {
  try {
    return JSON.parse(window.localStorage.getItem("openclaw-cron-monitor-usage") || "{}") || {};
  } catch {
    return {};
  }
}

function recordLocalUsage(key) {
  try {
    const usage = localUsage();
    usage[key] = Number(usage[key] || 0) + 1;
    usage.lastSeenAt = new Date().toISOString();
    window.localStorage.setItem("openclaw-cron-monitor-usage", JSON.stringify(usage));
  } catch {
    // Local usage telemetry is best-effort and browser-local only.
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}
