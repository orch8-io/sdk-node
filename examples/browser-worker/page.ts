// Browser side: runs `confirm_shipping` steps that need a human and this page.
// The page never holds an API key or any secret: it asks YOUR backend for a
// short-lived, browser-scoped session token.
import { BrowserWorker, querySelectorText, readForm } from "@orch8.io/sdk/browser";

const statusEl = document.getElementById("status")!;
const form = document.getElementById("shipping") as HTMLFormElement;

const worker = new BrowserWorker({
  baseUrl: "https://orch8.example.com", // must list this origin in ORCH8_CORS_ORIGINS
  getToken: async () => {
    // Authenticated by your app's own session cookie.
    const res = await fetch("/api/orch8/browser-session", { method: "POST", credentials: "include" });
    if (!res.ok) throw new Error(`session endpoint returned ${res.status}`);
    return res.json(); // { token, runtimeId, expiresAt, handlers }
  },
  onEvent: (event) => {
    // Events carry ids only, never step input or output.
    if (event.type === "task_started") statusEl.textContent = "Please confirm shipping details.";
    if (event.type === "released") statusEl.textContent = "Paused while the tab is hidden.";
    if (event.type === "stopped") statusEl.textContent = `Stopped (${event.reason}).`;
  },
});

worker.register<{ orderId: string }, Record<string, unknown>>("confirm_shipping", (input, ctx) =>
  new Promise((resolve, reject) => {
    form.hidden = false;
    const onSubmit = (event: SubmitEvent) => {
      event.preventDefault();
      cleanup();
      // Page data (user input + DOM) is returned as step output.
      resolve({
        orderId: input.orderId,
        orderTitle: querySelectorText(".order-title"),
        shipping: readForm(form),
        idempotencyKey: ctx.effectId,
      });
    };
    // Lease lost, tab hidden/closed, or step timeout: stop waiting for the user.
    const onAbort = () => {
      cleanup();
      reject(ctx.signal.reason);
    };
    const cleanup = () => {
      form.hidden = true;
      form.removeEventListener("submit", onSubmit);
      ctx.signal.removeEventListener("abort", onAbort);
    };
    form.addEventListener("submit", onSubmit);
    ctx.signal.addEventListener("abort", onAbort);
  }),
);

void worker.start();
