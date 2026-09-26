import { afterEach, describe, expect, it, vi } from "vitest";
import { Orch8Worker } from "../worker.js";
import { FakeOrch8Server } from "../testing/index.js";
import {
  aiSdkToolHandlers,
  checkpointSteps,
  durableTools,
  DurableToolError,
  TurnCheckpointer,
} from "../ai/ai-sdk.js";
import { agentToolHandlers, checkpointRunState, durableAgentTools } from "../ai/openai-agents.js";

const wait = { pollIntervalMs: 5, timeoutMs: 5_000 };
const workers: Orch8Worker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((w) => w.stop()));
});

async function startWorker(engine: FakeOrch8Server, handlers: Record<string, any>) {
  const worker = new Orch8Worker({ client: engine.client(), workerId: "ai-worker", pollIntervalMs: 5, handlers });
  workers.push(worker);
  await worker.start();
}

describe("Vercel AI SDK adapter", () => {
  it("runs each tool call as an idempotent job keyed by toolCallId", async () => {
    const engine = new FakeOrch8Server();
    const client = engine.client();
    const execute = vi.fn(async ({ city }: { city: string }, opts: { toolCallId: string; messages?: unknown[] }) => ({ city, temp: 21, call: opts.toolCallId }));
    const original = {
      getWeather: { description: "weather", inputSchema: { type: "object" }, execute },
      askUser: { description: "client-side tool, no execute" },
    };
    await startWorker(engine, aiSdkToolHandlers(original));

    const tools = durableTools(original, { client, scope: "conv-1", wait });
    expect(tools.getWeather.description).toBe("weather");
    expect(tools.getWeather.inputSchema).toEqual({ type: "object" });
    expect(tools.askUser).toBe(original.askUser);

    const first = await tools.getWeather.execute!({ city: "Kyiv" }, { toolCallId: "call_1", messages: [] });
    const replay = await tools.getWeather.execute!({ city: "Kyiv" }, { toolCallId: "call_1", messages: [] });
    expect(first).toEqual({ city: "Kyiv", temp: 21, call: "call_1" });
    expect(replay).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(1);

    const [job] = [...engine.jobs.values()];
    expect(job.job.handler).toBe("ai-tool.getWeather");
    expect(job.payload).toEqual({ tool: "getWeather", tool_call_id: "call_1", args: { city: "Kyiv" } });
    expect(engine.requests.find((r) => r.path === "/jobs")?.body).toMatchObject({ idempotency_key: "conv-1:getWeather:call_1" });
  });

  it("derives a content-hash call id when none is supplied and surfaces failures", async () => {
    const engine = new FakeOrch8Server();
    const client = engine.client();
    const boom = { execute: vi.fn(async (_args: unknown, _opts: { toolCallId: string }): Promise<never> => { throw new Error("card declined"); }) };
    await startWorker(engine, aiSdkToolHandlers({ boom }));
    const tools = durableTools({ boom }, { client, wait });
    const err = await tools.boom.execute!({ b: 1, a: 2 }, { toolCallId: "" }).catch((e) => e);
    expect(err).toBeInstanceOf(DurableToolError);
    expect(err.status).toBe("failed");
    const key = engine.requests.find((r) => r.path === "/jobs")?.body as { idempotency_key: string };
    expect(key.idempotency_key).toMatch(/^ai:boom:sha256-[0-9a-f]{32}$/);
  });

  it("checkpoints each step and resumes the turn counter", async () => {
    const engine = new FakeOrch8Server();
    const client = engine.client();
    engine.enqueueTask({ handler_name: "agent-turn" });
    const [task] = await client.pollTasks({ handler_name: "agent-turn", worker_id: "w" });
    const checkpointer = new TurnCheckpointer({ client, task, workerId: "w" });
    const onStepFinish = checkpointSteps(checkpointer);
    await onStepFinish({ text: "thinking", finishReason: "tool-calls", toolCalls: [{ toolCallId: "c1", toolName: "getWeather", args: {} }], response: { messages: [{ role: "assistant" }] } });
    await onStepFinish({ text: "done", finishReason: "stop" });
    expect(engine.task(task.id)?.resume_checkpoint).toEqual({ turn: 2, text: "done", finishReason: "stop", toolCalls: [] });
    expect(engine.task(task.id)?.checkpoint_seq).toBe(2);

    // A retried attempt sees the checkpoint and continues numbering.
    const retried = { ...task, resume_checkpoint: { turn: 2 }, checkpoint_seq: 2 };
    const resumed = checkpointSteps(new TurnCheckpointer({ client, task: retried, workerId: "w" }), (_s, turn) => ({ turn }));
    await resumed({});
    expect(engine.task(task.id)?.resume_checkpoint).toEqual({ turn: 3 });
  });
});

describe("OpenAI Agents SDK adapter", () => {
  function fakeTool(name: string, impl: (args: any) => unknown) {
    return {
      type: "function" as const,
      name,
      description: `${name} tool`,
      parameters: { type: "object" },
      strict: true,
      invoke: vi.fn(async (_ctx: unknown, input: string, _details?: unknown) => impl(JSON.parse(input))),
    };
  }

  it("routes function tools through idempotent jobs keyed by callId", async () => {
    const engine = new FakeOrch8Server();
    const client = engine.client();
    const lookup = fakeTool("lookup_order", ({ id }) => ({ id, status: "shipped" }));
    const hosted = { type: "hosted_tool", name: "web_search" };
    await startWorker(engine, agentToolHandlers([lookup, hosted], { createRunContext: () => ({ context: {} }) }));

    const [durable, hostedOut] = durableAgentTools([lookup, hosted], { client, scope: "thread-9", wait });
    expect(hostedOut).toBe(hosted);
    expect(durable).not.toBe(lookup);
    expect((durable as typeof lookup).parameters).toEqual({ type: "object" });

    const call = { toolCall: { callId: "call_A" } };
    const out1 = await (durable as typeof lookup).invoke({}, '{"id":"o-1"}', call);
    const out2 = await (durable as typeof lookup).invoke({}, '{"id":"o-1"}', call);
    expect(out1).toEqual({ id: "o-1", status: "shipped" });
    expect(out2).toEqual(out1);
    expect(lookup.invoke).toHaveBeenCalledTimes(1);
    expect(lookup.invoke.mock.calls[0][2]).toMatchObject({ toolCall: { callId: "call_A", name: "lookup_order" } });
    expect(engine.requests.find((r) => r.path === "/jobs")?.body).toMatchObject({
      handler: "ai-tool.lookup_order",
      idempotency_key: "thread-9:lookup_order:call_A",
    });
  });

  it("checkpoints serialized RunState per turn", async () => {
    const engine = new FakeOrch8Server();
    const client = engine.client();
    engine.enqueueTask({ handler_name: "agent" });
    const [task] = await client.pollTasks({ handler_name: "agent", worker_id: "w" });
    const checkpointer = new TurnCheckpointer<{ turn: number; state: string }>({ client, task, workerId: "w" });
    await checkpointRunState(checkpointer, { state: { toString: () => "S1" } });
    const second = await checkpointRunState(checkpointer, { state: { toString: () => "S2" } });
    expect(second).toEqual({ turn: 2, state: "S2" });
    expect(engine.task(task.id)?.resume_checkpoint).toEqual({ turn: 2, state: "S2" });
  });
});
