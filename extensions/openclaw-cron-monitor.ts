import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { loadOverview, loadRuns } from "../server.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "cron_monitor_overview",
    label: "Cron Monitor Overview",
    description: "Read OpenClaw cron jobs, status counts, projected schedule events, and recent run summaries.",
    parameters: Type.Object({
      includeJobs: Type.Optional(Type.Boolean({ description: "Include normalized job records. Defaults to true." })),
      includeEvents: Type.Optional(Type.Boolean({ description: "Include calendar events and projections. Defaults to false." })),
    }),
    async execute(_toolCallId, params) {
      const overview = await loadOverview();
      const includeJobs = params.includeJobs !== false;
      const includeEvents = params.includeEvents === true;
      const payload = {
        generatedAt: overview.generatedAt,
        source: overview.source,
        host: overview.host,
        counts: overview.counts,
        paths: overview.paths,
        jobs: includeJobs ? overview.jobs : undefined,
        events: includeEvents ? overview.events : undefined,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: payload,
      };
    },
  });

  pi.registerTool({
    name: "cron_monitor_runs",
    label: "Cron Monitor Runs",
    description: "Read recent run records for one OpenClaw cron job by job id.",
    parameters: Type.Object({
      jobId: Type.String({ description: "OpenClaw cron job id." }),
      limit: Type.Optional(Type.Number({ description: "Maximum number of runs to return. Defaults to 20." })),
    }),
    async execute(_toolCallId, params) {
      const runs = await loadRuns(params.jobId, params.limit || 20);
      const payload = {
        jobId: params.jobId,
        runs,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        details: payload,
      };
    },
  });

  pi.registerCommand("cron-monitor", {
    description: "Show how to launch the OpenClaw cron monitor web dashboard.",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Run `openclaw-cron-monitor` for localhost access, or set HOST explicitly for trusted-network access.", "info");
    },
  });
}
