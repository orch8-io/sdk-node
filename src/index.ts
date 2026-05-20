export { Orch8Client, Orch8Error } from "./client.js";
export { Orch8Worker, type WorkerConfig, type HandlerFn } from "./worker.js";
export { WorkflowBuilder, workflow, type StepOptions } from "./builder.js";
export { verifyWebhookSignature } from "./webhook.js";
export type * from "./types.js";

// Explicit re-exports from schema to avoid `HumanChoice` ambiguity (also
// declared in types.ts as a plain interface).
export {
  DurationMsSchema,
  DelaySpecSchema,
  SendWindowSchema,
  ContextAccessSchema,
  HumanChoiceSchema,
  HumanInputDefSchema,
  EscalationDefSchema,
  RetryPolicySchema,
  BlockDefinitionSchema,
  StepBlockSchema,
  ParallelBlockSchema,
  RaceSemanticsSchema,
  RaceBlockSchema,
  LoopBlockSchema,
  ForEachBlockSchema,
  RouteSchema,
  RouterBlockSchema,
  TryCatchBlockSchema,
  SubSequenceBlockSchema,
  ABVariantSchema,
  ABSplitBlockSchema,
  CancellationScopeBlockSchema,
  SequenceCreateSchema,
} from "./schema.js";

export type {
  DelaySpec,
  SendWindow,
  ContextAccess,
  HumanInputDef,
  EscalationDef,
  RetryPolicy,
  BlockDefinition,
  StepBlock,
  ParallelBlock,
  RaceSemantics,
  RaceBlock,
  LoopBlock,
  ForEachBlock,
  Route,
  RouterBlock,
  TryCatchBlock,
  SubSequenceBlock,
  ABVariant,
  ABSplitBlock,
  CancellationScopeBlock,
  SequenceCreate,
} from "./schema.js";
