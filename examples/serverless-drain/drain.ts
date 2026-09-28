// drainOnce in any short-lived process (Kubernetes CronJob, GitHub Actions,
// Vercel cron): claim up to 20 tasks, finish or release everything within 50 s.
import { Orch8Client, drainOnce } from "@orch8.io/sdk/serverless";

const result = await drainOnce({
  client: new Orch8Client({
    baseUrl: process.env.ORCH8_URL!,
    tenantId: process.env.ORCH8_TENANT_ID,
    headers: { "x-api-key": process.env.ORCH8_API_KEY! },
  }),
  handlers: { "report.build": async (task) => ({ built: task.params }) },
  maxTasks: 20,
  deadlineMs: Date.now() + 50_000,
});
console.log(JSON.stringify({ claimed: result.claimed, completed: result.completed, released: result.released, stoppedBy: result.stoppedBy }));
process.exitCode = result.stoppedBy === "poll_error" ? 1 : 0;
