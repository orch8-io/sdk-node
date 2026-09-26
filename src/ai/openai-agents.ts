import type { HandlerFn } from "../worker.js";
import {
  TurnCheckpointer,
  defaultToolHandlerName,
  runToolCallAsJob,
  toolCallFromTask,
  type DurableToolOptions,
} from "./durable.js";

/**
 * Structural OpenAI Agents SDK (JS) function tool, as returned by `tool()`
 * from `@openai/agents`. The SDK calls `invoke(runContext, input, details)`
 * with `input` as a JSON string and `details.toolCall.callId`.
 */
export interface AgentsFunctionTool {
  type: "function";
  name: string;
  invoke: (runContext: any, input: string, details?: AgentsToolDetails) => Promise<unknown> | unknown;
  [key: string]: unknown;
}

export interface AgentsToolDetails {
  toolCall?: { callId?: string; id?: string; [key: string]: unknown };
  [key: string]: unknown;
}

function parseInput(input: string): unknown {
  if (!input) return {};
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function withInvoke<T extends AgentsFunctionTool>(tool: T, invoke: AgentsFunctionTool["invoke"]): T {
  const copy = Object.create(Object.getPrototypeOf(tool)) as T;
  Object.assign(copy, tool, { invoke });
  return copy;
}

/**
 * Wrap Agents SDK function tools so each call runs as an idempotent Orch8
 * job keyed by `toolCall.callId`. Non-function tools (hosted tools, computer
 * use, handoffs) are returned unchanged.
 *
 * ```ts
 * const agent = new Agent({ name: "support", tools: durableAgentTools([lookupOrder, refund], { client, scope: threadId }) });
 * ```
 */
export function durableAgentTools<T extends { type?: unknown; name?: unknown }>(
  tools: T[],
  options: DurableToolOptions,
): T[] {
  return tools.map((tool) => {
    if (!isFunctionTool(tool)) return tool;
    return withInvoke(tool, (_ctx, input, details) =>
      runToolCallAsJob(options, tool.name, details?.toolCall?.callId ?? details?.toolCall?.id, parseInput(input)),
    ) as unknown as T;
  });
}

function isFunctionTool(tool: unknown): tool is AgentsFunctionTool {
  return !!tool && typeof tool === "object" && (tool as AgentsFunctionTool).type === "function"
    && typeof (tool as AgentsFunctionTool).name === "string"
    && typeof (tool as AgentsFunctionTool).invoke === "function";
}

export interface AgentToolHandlerOptions extends Pick<DurableToolOptions, "handlerName"> {
  /**
   * Build the run context handed to `invoke` on the worker. Default: a
   * `RunContext` from `@openai/agents` when installed, else `{ context: {} }`.
   */
  createRunContext?: () => unknown;
}

function defaultRunContext(): unknown {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@openai/agents") as { RunContext?: new (context?: unknown) => unknown };
    if (mod.RunContext) return new mod.RunContext({});
  } catch {
    // optional peer not installed
  }
  return { context: {} };
}

/** Worker handlers executing the original tools for jobs from {@link durableAgentTools}. */
export function agentToolHandlers(
  tools: Array<{ type?: unknown; name?: unknown }>,
  options: AgentToolHandlerOptions = {},
): Record<string, HandlerFn> {
  const handlers: Record<string, HandlerFn> = {};
  const nameFor = options.handlerName ?? defaultToolHandlerName;
  for (const tool of tools) {
    if (!isFunctionTool(tool)) continue;
    handlers[nameFor(tool.name)] = async (task) => {
      const call = toolCallFromTask(task);
      const ctx = (options.createRunContext ?? defaultRunContext)();
      return tool.invoke(ctx, JSON.stringify(call.args ?? {}), {
        toolCall: { type: "function_call", callId: call.tool_call_id, name: tool.name, arguments: JSON.stringify(call.args ?? {}) },
      });
    };
  }
  return handlers;
}

/** Shape of `RunResult` needed for checkpointing (`result.state.toString()`). */
export interface AgentsRunResultLike {
  state: { toString(): string };
  [key: string]: unknown;
}

export interface AgentRunCheckpoint {
  turn: number;
  /** Serialized `RunState`; restore with `RunState.fromString(agent, state)`. */
  state: string;
}

/**
 * Checkpoint an Agents SDK run at a turn boundary. Call after each `run()`
 * (or interruption); on retry, `checkpointer.resume()?.state` restores it via
 * `RunState.fromString(agent, state)`.
 */
export async function checkpointRunState(
  checkpointer: TurnCheckpointer<AgentRunCheckpoint>,
  result: AgentsRunResultLike,
): Promise<AgentRunCheckpoint> {
  const previous = checkpointer.latest();
  const checkpoint = { turn: (previous?.turn ?? 0) + 1, state: result.state.toString() };
  await checkpointer.checkpoint(checkpoint);
  return checkpoint;
}

export {
  TurnCheckpointer,
  DurableToolError,
  runToolCallAsJob,
  toolCallFromTask,
  defaultToolHandlerName,
  type DurableToolOptions,
  type DurableToolCallPayload,
  type TurnCheckpointerOptions,
} from "./durable.js";
