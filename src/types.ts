/** Configuration for the Orch8Client. */
export interface Orch8ClientConfig {
  /** Base URL of the Orch8 engine API (e.g. "http://localhost:8080"). */
  baseUrl: string;
  /** Default tenant ID sent via X-Tenant-Id header. */
  tenantId?: string;
  /** Default namespace query parameter. */
  namespace?: string;
  /** Additional headers to include with every request. */
  headers?: Record<string, string>;
  /** Resolve short-lived auth headers immediately before every attempt. */
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Safe-request retry policy. Set to false to disable retries. */
  retry?: RetryConfig | false;
  /** Per-attempt timeout in milliseconds. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Called immediately before each HTTP attempt. Observer errors are ignored. */
  onRequest?: (event: RequestEvent) => void;
  /** Called after every HTTP attempt. Observer errors are ignored. */
  onResponse?: (event: ResponseEvent) => void;
}

export interface RetryConfig {
  /** Total attempts, including the first request. Defaults to 3. */
  maxAttempts?: number;
  /** Initial exponential-backoff delay. Defaults to 250 milliseconds. */
  baseDelayMs?: number;
  /** Called before each retry. Attempt is one-based (the next attempt). */
  onRetry?: (error: unknown, attempt: number) => void;
}

export interface RequestEvent {
  method: string;
  path: string;
  attempt: number;
  maxAttempts: number;
}

export interface ResponseEvent extends RequestEvent {
  durationMs: number;
  status?: number;
  error?: unknown;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  total?: number;
}

export interface InstanceStreamOptions {
  pollMs?: number;
  lastEventId?: string;
  signal?: AbortSignal;
}

export interface InstanceStreamEvent<T = Record<string, unknown>> {
  id?: string;
  event?: string;
  data: T;
}

export interface SequenceDefinition {
  id: string;
  tenant_id: string;
  namespace: string;
  name: string;
  version: number;
  deprecated: boolean;
  blocks: unknown[];
  interceptors?: unknown;
  input_schema?: unknown;
  sla?: { max_runtime?: number; max_step_runtime?: number };
  on_failure?: unknown[];
  on_cancel?: unknown[];
  status?: "draft" | "staging" | "production" | "unpublished";
  created_at: string;
}

export interface CreateSequenceResponse {
  id: string;
  warnings?: string[];
}

export interface TaskInstance {
  id: string;
  sequence_id: string;
  tenant_id: string;
  namespace: string;
  state: string;
  next_fire_at: string | null;
  priority: number;
  timezone: string;
  metadata: Record<string, unknown>;
  context: ExecutionContext;
  concurrency_key: string | null;
  max_concurrency: number | null;
  idempotency_key: string | null;
  session_id: string | null;
  parent_instance_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExecutionContext {
  data: Record<string, unknown>;
  config: Record<string, unknown>;
  audit: AuditEntry[];
  runtime: Record<string, unknown>;
}

export interface AuditEntry {
  timestamp: string;
  event: string;
  details: unknown;
}

export interface ExecutionNode {
  id: string;
  instance_id: string;
  block_id: string;
  parent_id: string | null;
  block_type: string;
  branch_index: number | null;
  state: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface StepOutput {
  id: string;
  instance_id: string;
  block_id: string;
  output: unknown;
  output_ref: string | null;
  output_size: number;
  attempt: number;
  created_at: string;
}

export interface Checkpoint {
  id: string;
  instance_id: string;
  checkpoint_data: unknown;
  created_at: string;
}

export interface CronSchedule {
  id: string;
  tenant_id: string;
  namespace: string;
  sequence_id: string;
  version: number | null;
  cron_expr: string;
  timezone: string;
  enabled: boolean;
  metadata: unknown;
  last_triggered_at: string | null;
  next_fire_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TriggerDef {
  slug: string;
  sequence_name: string;
  version: number | null;
  tenant_id: string;
  namespace: string;
  enabled: boolean;
  secret: string | null;
  trigger_type: string;
  config: unknown;
  created_at: string;
  updated_at: string;
}

export interface PluginDef {
  name: string;
  plugin_type: string;
  source: string;
  tenant_id: string;
  enabled: boolean;
  config: unknown;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export interface Session {
  id: string;
  tenant_id: string;
  session_key: string;
  state: string;
  data: unknown;
  created_at: string;
  updated_at: string;
}

export interface WorkerTask {
  id: string;
  instance_id: string;
  block_id: string;
  handler_name: string;
  queue_name: string | null;
  params: unknown;
  context: unknown;
  attempt: number;
  timeout_ms: number | null;
  state: "pending" | "claimed" | "completed" | "failed";
  worker_id: string | null;
  claimed_at: string | null;
  heartbeat_at: string | null;
  completed_at: string | null;
  output: unknown | null;
  error_message: string | null;
  error_retryable: boolean | null;
  created_at: string;
  resume_checkpoint?: unknown;
  checkpoint_seq: number;
}

export interface ClusterNode {
  id: string;
  address: string;
  state: string;
  last_heartbeat: string;
}

export interface CircuitBreaker {
  handler: string;
  state: string;
  failure_count: number;
  last_failure: string | null;
}

export interface FireTriggerResponse {
  instance_id: string;
  trigger: string;
  sequence_name: string;
}

export interface BulkResponse {
  updated: number;
}

export interface BatchCreateResponse {
  created: number;
}

export interface HealthResponse {
  status: string;
}

export interface ResourcePool {
  id: string;
  tenant_id: string;
  name: string;
  max_size: number;
  current_size: number;
  config: unknown;
  created_at: string;
  updated_at: string;
}

export interface PoolResource {
  id: string;
  pool_id: string;
  resource_key: string;
  state: string;
  data: unknown;
  locked_by: string | null;
  locked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Credential {
  id: string;
  tenant_id: string;
  name: string;
  credential_type: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Mobile Sync
// ---------------------------------------------------------------------------

export interface HumanChoice {
  label: string;
  value: string;
}

export interface StatusUpdatePayload {
  instance_id: string;
  sequence_name: string;
  state: string;
  current_step?: string;
  handler?: string;
  timestamp?: string;
  context_summary?: unknown;
  steps?: unknown[];
}

export interface ApprovalRequestPayload {
  instance_id: string;
  block_id: string;
  sequence_name: string;
  prompt: string;
  choices?: HumanChoice[];
  store_as?: string;
  timeout_seconds?: number;
  metadata?: unknown;
}

export interface StepDelegationPayload {
  request_id: string;
  instance_id: string;
  block_id: string;
  handler: string;
  params?: unknown;
}

export interface CommandPayload {
  id: string;
  type: string;
  payload?: unknown;
}

export interface SyncRequest {
  device_id: string;
  status_updates?: StatusUpdatePayload[];
  approval_requests?: ApprovalRequestPayload[];
  step_delegations?: StepDelegationPayload[];
  command_acks?: string[];
}

export interface SyncResponse {
  commands: CommandPayload[];
  sync_interval_secs: number;
}

export interface RegisterDeviceRequest {
  device_id: string;
  push_token?: string;
  platform: string;
  app_version?: string;
}

export interface ResolveApprovalRequest {
  output?: unknown;
}

export interface CreateCommandRequest {
  device_id: string;
  command_type: string;
  payload?: unknown;
}

export interface MobileDevice {
  id: string;
  device_id: string;
  push_token?: string;
  platform: string;
  app_version?: string;
  created_at: string;
}

export interface MobileStatusItem {
  instance_id: string;
  state: string;
  current_step?: string;
  updated_at: string;
}

export interface MobileDevicesResponse {
  items: MobileDevice[];
  total: number;
}

export interface MobileApprovalsResponse {
  items: ApprovalItem[];
  total: number;
}

export interface MobileStatusResponse {
  items: MobileStatusItem[];
  total: number;
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

export interface DeviceContext {
  device_id: string;
  os_name?: string;
  os_version?: string;
  app_version?: string;
  sdk_version?: string;
}

export interface TelemetryBatchItem {
  event_type: string;
  payload?: unknown;
  timestamp?: string;
  device?: DeviceContext;
}

export interface IngestTelemetryRequest {
  events: TelemetryBatchItem[];
  tenant_id?: string;
}

export interface IngestErrorRequest {
  error_type: string;
  message: string;
  stack_trace?: string;
  device?: DeviceContext;
  tenant_id?: string;
  instance_id?: string;
  sequence_name?: string;
}

export interface IngestResponse {
  accepted: number;
}

export type DashboardQueryType =
  | "SyncCompletedVersions"
  | "ErrorRatePerSequence"
  | "TopFailingSteps"
  | "DeviceOsBreakdown";

export interface DashboardRow {
  dimension: string;
  count: number;
  percentage: number;
}

export interface DashboardResponse {
  rows: DashboardRow[];
}

// ---------------------------------------------------------------------------
// Rollback Policies
// ---------------------------------------------------------------------------

export interface RollbackPolicy {
  id: number;
  tenant_id: string;
  sequence_name: string;
  error_rate_threshold: number;
  time_window_secs: number;
  enabled: boolean;
  cooldown_secs: number;
  confirmation_window_secs: number;
  webhook_url?: string;
  created_at: string;
  updated_at: string;
}

export interface CreatePolicyRequest {
  tenant_id: string;
  sequence_name: string;
  error_rate_threshold: number;
  time_window_secs: number;
  cooldown_secs?: number;
  confirmation_window_secs?: number;
  webhook_url?: string;
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export interface ApprovalItem {
  instance_id: string;
  tenant_id: string;
  namespace: string;
  sequence_id: string;
  sequence_name: string;
  block_id: string;
  prompt: string;
  choices: HumanChoice[];
  store_as?: string;
  timeout_seconds?: number;
  escalation_handler?: string;
  waiting_since: string;
  deadline?: string;
  metadata?: unknown;
  allow_comment: boolean;
}

export interface ApprovalsResponse {
  items: ApprovalItem[];
  total: number;
}

// ---------------------------------------------------------------------------
// Typed Request Payloads
// ---------------------------------------------------------------------------

export interface CreateInstanceRequest {
  sequence_id: string;
  tenant_id?: string;
  namespace?: string;
  state?: string;
  priority?: number;
  timezone?: string;
  metadata?: unknown;
  context?: Record<string, unknown>;
  concurrency_key?: string;
  max_concurrency?: number;
  idempotency_key?: string;
  session_id?: string;
  parent_instance_id?: string;
  next_fire_at?: string;
  dry_run?: boolean;
  dry_run_auto_approve?: boolean;
}

export interface UpdateStateRequest {
  state: string;
  next_fire_at?: string;
}

export interface UpdateContextRequest {
  context?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SendSignalRequest {
  signal_type?: string;
  payload?: unknown;
  [key: string]: unknown;
}

export interface CreateCronRequest {
  tenant_id?: string;
  namespace?: string;
  sequence_id: string;
  cron_expr: string;
  timezone?: string;
  enabled?: boolean;
  metadata?: unknown;
}

export interface UpdateCronRequest {
  cron_expr?: string;
  timezone?: string;
  enabled?: boolean;
  metadata?: unknown;
}

export interface CreateTriggerRequest {
  slug: string;
  sequence_name: string;
  tenant_id?: string;
  namespace?: string;
  version?: number;
  enabled?: boolean;
  secret?: string;
  trigger_type?: string;
  config?: unknown;
}

export interface CreateCredentialRequest {
  tenant_id?: string;
  name: string;
  credential_type?: string;
  metadata?: Record<string, unknown>;
  value?: unknown;
}

export interface UpdateCredentialRequest {
  name?: string;
  credential_type?: string;
  metadata?: Record<string, unknown>;
  value?: unknown;
}

export interface CreateSessionRequest {
  tenant_id?: string;
  session_key?: string;
  data?: unknown;
  state?: string;
  expires_at?: string;
}

export interface CreatePoolRequest {
  tenant_id?: string;
  name: string;
  strategy?: "round_robin" | "weighted" | "random";
  config?: unknown;
}

export interface AddResourceRequest {
  resource_key: string;
  name: string;
  weight?: number;
  daily_cap?: number;
  warmup_start?: string;
  warmup_days?: number;
  warmup_start_cap?: number;
  data?: unknown;
}

export interface UpdateResourceRequest {
  name?: string;
  weight?: number;
  enabled?: boolean;
  daily_cap?: number;
  warmup_start?: string;
  warmup_days?: number;
  warmup_start_cap?: number;
  data?: unknown;
}

export interface PollRequest {
  handler_name?: string;
  worker_id?: string;
  limit?: number;
  capacity?: number;
  [key: string]: unknown;
}

export interface QueuePollRequest {
  queue_name?: string;
  handler_name?: string;
  worker_id?: string;
  limit?: number;
  [key: string]: unknown;
}

export interface CompleteRequest {
  worker_id?: string;
  output?: unknown;
  [key: string]: unknown;
}

export interface FailRequest {
  worker_id?: string;
  message?: string;
  error?: string;
  retryable?: boolean;
  [key: string]: unknown;
}

export interface HeartbeatRequest {
  worker_id?: string;
  checkpoint?: unknown;
  checkpoint_seq?: number;
  [key: string]: unknown;
}

export interface HeartbeatResponse {
  checkpoint_seq: number;
}
