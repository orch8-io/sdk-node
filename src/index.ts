export { Orch8Client, Orch8Error } from "./client.js";
export { ContinuityClient, type JsonObject, type QueryValue } from "./continuity.js";
export { Orch8Worker, type WorkerConfig, type HandlerFn, type WorkerRuntimeStats } from "./worker.js";
export { WorkflowBuilder, workflow, type StepOptions } from "./builder.js";
export { verifyWebhookSignature } from "./webhook.js";
export type * from "./types.js";
export { ORCH8_API_VERSION, ORCH8_ROUTES } from "./generated/routes.js";

// Explicit re-exports from schema to avoid `HumanChoice` ambiguity (also
// declared in types.ts as a plain interface).
export {
  DurationMsSchema,
  DelaySpecSchema,
  SendWindowSchema,
  ContextAccessSchema,
  FieldAccessSchema,
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
  SagaStepSchema,
  SagaBlockSchema,
  SequenceCreateSchema,
} from "./schema.js";

export type {
  DelaySpec,
  SendWindow,
  ContextAccess,
  FieldAccess,
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
  SagaStep,
  SagaBlock,
  SequenceCreate,
} from "./schema.js";
