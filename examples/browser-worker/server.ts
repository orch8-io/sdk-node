// Backend side (Node): mints browser sessions and defines a workflow whose
// `confirm_shipping` step is placed on the browser. The API key stays here.
import express from "express";
import { Orch8Client, workflow } from "@orch8.io/sdk";

const orch8 = new Orch8Client({
  baseUrl: process.env.ORCH8_ENGINE_URL ?? "http://localhost:8080",
  tenantId: process.env.ORCH8_TENANT_ID,
  headers: { "x-api-key": process.env.ORCH8_API_KEY ?? "" }, // operator/admin key
});

const app = express();

// Replace with your real authentication; tie the runtime id to the signed-in user.
function currentUserId(req: express.Request): string | null {
  return (req.headers["x-demo-user"] as string | undefined) ?? null;
}

app.post("/api/orch8/browser-session", async (req, res) => {
  const userId = currentUserId(req);
  if (!userId) return res.status(401).end();
  const session = await orch8.createBrowserSession({
    runtimeId: `browser-${userId}`, // stable per user: targeted steps wait in this "mailbox"
    handlers: ["confirm_shipping"],
    ttlSecs: 900,
  });
  res.json(session); // { token, runtimeId, expiresAt, handlers }
});

// Workflow: the browser step receives no credentials (the engine refuses to
// dispatch credential-bearing steps to browser runtimes).
export const fulfilment = workflow("fulfilment")
  .step("confirm", "confirm_shipping", { orderId: "{{context.data.order_id}}" }, {
    runtime: { runtime_kinds: ["browser"], requires_human_ui: true },
    timeout: 15 * 60_000,
  })
  .step("ship", "create_shipment", { shipping: "{{outputs.confirm.shipping}}" })
  .build();

app.listen(3000, () => console.log("listening on http://localhost:3000"));
