/** Structural adapter for LangGraph, CrewAI, AutoGen, and similar runners.
 * No framework package is imported, so applications keep version ownership. */
export interface AgentRunner<Input = unknown, Output = unknown> {
  invoke?(input: Input, config?: unknown): Output | Promise<Output>;
  ainvoke?(input: Input, config?: unknown): Promise<Output>;
  kickoff?(input: Input): Output | Promise<Output>;
  run?(input: Input): Output | Promise<Output>;
}

export interface DurableAgentTask<Input = unknown> {
  params: Input;
  instance_id?: string;
  instanceId?: string;
}

export function durableAgentHandler<Input = unknown, Output = unknown>(
  runner: AgentRunner<Input, Output>,
): (task: DurableAgentTask<Input>) => Promise<Output> {
  return async (task) => {
    const threadId = task.instance_id ?? task.instanceId;
    const config = threadId ? { configurable: { thread_id: threadId } } : undefined;
    if (runner.ainvoke) return runner.ainvoke(task.params, config);
    if (runner.invoke) return runner.invoke(task.params, config);
    if (runner.kickoff) return runner.kickoff(task.params);
    if (runner.run) return runner.run(task.params);
    throw new TypeError("agent runner must implement ainvoke, invoke, kickoff, or run");
  };
}
