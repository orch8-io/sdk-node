import type { HandlerFn } from "../worker.js";
import {
  TurnCheckpointer,
  defaultToolHandlerName,
  runToolCallAsJob,
  toolCallFromTask,
  type DurableToolOptions,
} from "./durable.js";

/**
 * Structural Vercel AI SDK tool (v4 `parameters` or v5 `inputSchema`). The
 * `ai` package is not imported; pass the objects returned by `tool()`.
 */
export interface AiSdkTool {
  description?: string;
  parameters?: unknown;
  inputSchema?: unknown;
  execute?: (args: any, options: AiSdkToolExecutionOptions) => unknown;
  [key: string]: unknown;
}

export interface AiSdkToolExecutionOptions {
  toolCallId: string;
  messages?: unknown[];
  abortSignal?: AbortSignal;
  [key: string]: unknown;
}

/**
 * Wrap AI SDK tools so every call runs as an idempotent Orch8 job keyed by
 * the model's `toolCallId`. The model-facing definition (description,
 * schema) is unchanged; `execute` now enqueues, waits, and returns the job
 * output. Run {@link aiSdkToolHandlers} on a worker to execute the originals.
 *
 * ```ts
 * const tools = durableTools({ getWeather, chargeCard }, { client, scope: conversationId });
 * await generateText({ model, tools, prompt, onStepFinish: checkpointSteps(checkpointer) });
 * ```
 */
export function durableTools<T extends Record<string, AiSdkTool>>(tools: T, options: DurableToolOptions): T {
  const wrapped: Record<string, AiSdkTool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (typeof tool.execute !== "function") {
      wrapped[name] = tool; // client-side tool: nothing to make durable
      continue;
    }
    wrapped[name] = {
      ...tool,
      execute: (args: unknown, execOptions: AiSdkToolExecutionOptions) =>
        runToolCallAsJob(options, name, execOptions?.toolCallId, args),
    };
  }
  return wrapped as T;
}

/**
 * Worker handlers that execute the original tools for jobs created by
 * {@link durableTools}. Register them on an `Orch8Worker` (or push receiver).
 */
export function aiSdkToolHandlers(
  tools: Record<string, AiSdkTool>,
  options: Pick<DurableToolOptions, "handlerName"> = {},
): Record<string, HandlerFn> {
  const handlers: Record<string, HandlerFn> = {};
  const nameFor = options.handlerName ?? defaultToolHandlerName;
  for (const [name, tool] of Object.entries(tools)) {
    const execute = tool.execute;
    if (typeof execute !== "function") continue;
    handlers[nameFor(name)] = async (task) => {
      const call = toolCallFromTask(task);
      return execute.call(tool, call.args, { toolCallId: call.tool_call_id, messages: [] });
    };
  }
  return handlers;
}

/** Minimal step result shape passed to `onStepFinish`. */
export interface AiSdkStepResult {
  text?: string;
  finishReason?: string;
  toolCalls?: Array<{ toolCallId: string; toolName: string; [key: string]: unknown }>;
  toolResults?: unknown[];
  response?: { messages?: unknown[] };
  [key: string]: unknown;
}

export interface StepCheckpoint {
  turn: number;
  text?: string;
  finishReason?: string;
  toolCalls: Array<{ toolCallId: string; toolName: string }>;
  messages?: unknown[];
}

/**
 * `onStepFinish` callback that checkpoints each completed model step (turn).
 * By default it records the turn index, text, finish reason, tool-call ids,
 * and `response.messages` (so a retried task can resume the conversation via
 * `checkpointer.resume()?.messages`). Use `select` to store something smaller.
 */
export function checkpointSteps<S = StepCheckpoint>(
  checkpointer: TurnCheckpointer<S>,
  select?: (step: AiSdkStepResult, turn: number) => S,
): (step: AiSdkStepResult) => Promise<void> {
  const resumed = checkpointer.resume() as { turn?: number } | undefined;
  let turn = typeof resumed?.turn === "number" ? resumed.turn : 0;
  return async (step) => {
    turn += 1;
    const state = select
      ? select(step, turn)
      : ({
          turn,
          text: step.text,
          finishReason: step.finishReason,
          toolCalls: (step.toolCalls ?? []).map((c) => ({ toolCallId: c.toolCallId, toolName: c.toolName })),
          ...(step.response?.messages ? { messages: step.response.messages } : {}),
        } as unknown as S);
    await checkpointer.checkpoint(state);
  };
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
