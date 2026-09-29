// Cloudflare Workers executor: a Cron Trigger drains every minute, and a
// POST with `Authorization: Bearer $ORCH8_TRIGGER_SECRET` drains on demand
// (e.g. from a push-mode queue or a webhook). Uses fetch only — no Node APIs,
// no `nodejs_compat` flag.
import { Orch8Client, createCloudflareExecutor } from "@orch8.io/sdk/serverless";

interface Env {
  ORCH8_URL: string;
  ORCH8_TENANT_ID: string;
  ORCH8_API_KEY: string; // `wrangler secret put ORCH8_API_KEY`
  ORCH8_TRIGGER_SECRET: string; // `wrangler secret put ORCH8_TRIGGER_SECRET`
}

export default createCloudflareExecutor((env: Env) => ({
  client: new Orch8Client({
    baseUrl: env.ORCH8_URL,
    tenantId: env.ORCH8_TENANT_ID,
    headers: { "x-api-key": env.ORCH8_API_KEY },
  }),
  handlers: {
    "lead.enrich": async (task, ctx) => {
      const { domain } = task.params as { domain: string };
      const res = await fetch(`https://api.example.com/companies/${encodeURIComponent(domain)}`, {
        signal: ctx.signal,
        headers: { "Idempotency-Key": ctx.effectId ?? task.id },
      });
      return { company: await res.json() };
    },
  },
  maxTasks: 10,
  budgetMs: 25_000, // keep below your plan's limit; Workers expose no remaining-time API
  triggerSecret: env.ORCH8_TRIGGER_SECRET,
  capabilities: { regions: ["global"] }, // advertised as kind "edge"
}));
