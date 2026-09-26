import "reflect-metadata";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { Module, Injectable } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import type { WorkerTask } from "../types.js";
import { FakeOrch8Server } from "../testing/index.js";
import { getOrch8, orch8Express, orch8RawBody } from "../express/index.js";
import {
  Orch8Client,
} from "../client.js";
import {
  ORCH8_CLIENT,
  Orch8Handler,
  Orch8HandlerRegistry,
  Orch8Module,
  discoverHandlers,
} from "../nestjs/index.js";

const SECRET = "push-secret";

function signed(body: string) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");
  return { "content-type": "application/json", "x-orch8-timestamp": String(ts), "x-orch8-signature": `sha256=${sig}` };
}

async function serve(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

describe("express middleware", () => {
  for (const variant of ["before-json", "verify-hook"] as const) {
    it(`attaches the client and handles signed pushes (${variant})`, async () => {
      const engine = new FakeOrch8Server();
      const client = engine.client();
      const task = engine.enqueueTask({ handler_name: "send-email", queue_name: "emails", params: { to: "a@b.c" } });
      const app = express();
      const mw = orch8Express({ client, push: { secret: SECRET, handlers: { "send-email": async (t) => ({ sent: t.params }) } } });
      if (variant === "before-json") {
        app.use(mw);
        app.use(express.json());
      } else {
        app.use(express.json({ verify: orch8RawBody }));
        app.use(mw);
      }
      app.get("/whoami", (req, res) => res.json({ attached: getOrch8(req) === client }));
      const { url, close } = await serve(app);
      try {
        expect(await (await fetch(`${url}/whoami`)).json()).toEqual({ attached: true });
        const body = JSON.stringify({ task_id: task.id, instance_id: task.instance_id, block_id: "b", handler_name: "send-email", queue_name: "emails", params: {}, context: {}, attempt: 0, timeout_ms: null });
        const res = await fetch(`${url}/orch8/push`, { method: "POST", headers: signed(body), body });
        expect(res.status).toBe(200);
        expect(engine.task(task.id)?.output).toEqual({ sent: { to: "a@b.c" } });
        const bad = await fetch(`${url}/orch8/push`, { method: "POST", headers: { ...signed(body), "x-orch8-signature": "sha256=00" }, body });
        expect(bad.status).toBe(401);
      } finally {
        await close();
      }
    });
  }

  it("explains when the body was already parsed without the verify hook", async () => {
    const app = express();
    app.use(express.json());
    app.use(orch8Express({ client: new FakeOrch8Server().client(), push: { secret: SECRET, handlers: {} } }));
    const { url, close } = await serve(app);
    try {
      const res = await fetch(`${url}/orch8/push`, { method: "POST", headers: signed("{}"), body: "{}" });
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe("raw_body_unavailable");
    } finally {
      await close();
    }
  });
});

class EmailHandlers {
  constructor(readonly prefix = "hi") {}
  async send(task: WorkerTask) {
    return { greeting: `${this.prefix} ${(task.params as { name: string }).name}` };
  }
}
Orch8Handler("greet")(EmailHandlers.prototype, "send", Object.getOwnPropertyDescriptor(EmailHandlers.prototype, "send")!);
Injectable()(EmailHandlers);

describe("NestJS module", () => {
  it("discovers @Orch8Handler methods bound to their instance", async () => {
    const handlers = discoverHandlers([new EmailHandlers("yo")]);
    expect(Object.keys(handlers)).toEqual(["greet"]);
    expect(await handlers.greet({ params: { name: "Ada" } } as WorkerTask)).toEqual({ greeting: "yo Ada" });
    expect(() => discoverHandlers([new EmailHandlers(), new (class extends EmailHandlers {})()])).toThrow(/duplicate/);
  });

  it("supports standard (TC39) method decorators", () => {
    const fn = async () => 1;
    Orch8Handler("tc39")(fn, { kind: "method" });
    class X {}
    Object.defineProperty(X.prototype, "run", { value: fn });
    expect(Object.keys(discoverHandlers([new X()]))).toEqual(["tc39"]);
  });

  it("forRoot provides the client, discovers handlers, and runs the worker lifecycle", async () => {
    const engine = new FakeOrch8Server();
    const client = engine.client();
    class AppModule {}
    Module({
      imports: [Orch8Module.forRoot({ client, worker: { workerId: "nest-1", pollIntervalMs: 5 } })],
      providers: [{ provide: EmailHandlers, useFactory: () => new EmailHandlers() }],
    })(AppModule);

    const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    try {
      expect(app.get(ORCH8_CLIENT)).toBe(client);
      expect(app.get(Orch8Client)).toBe(client);
      const registry = app.get(Orch8HandlerRegistry);
      expect(Object.keys(registry.handlers)).toEqual(["greet"]);
      expect(registry.runningWorker?.stats().running).toBe(true);

      const task = engine.enqueueTask({ handler_name: "greet", params: { name: "Nest" } });
      const done = await engine.waitForTask(task.id);
      expect(done.output).toEqual({ greeting: "hi Nest" });
    } finally {
      await app.close();
    }
    expect(app.get(Orch8HandlerRegistry).runningWorker).toBeUndefined();
  });
});
