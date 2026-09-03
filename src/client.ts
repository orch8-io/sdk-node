import { randomUUID } from "node:crypto";

import type {
  Orch8ClientConfig,
  RetryConfig,
  RequestEvent,
  ResponseEvent,
  Page,
  InstanceStreamOptions,
  InstanceStreamEvent,
  SequenceDefinition,
  CreateSequenceResponse,
  TaskInstance,
  StepOutput,
  ExecutionNode,
  Checkpoint,
  CronSchedule,
  TriggerDef,
  PluginDef,
  Session,
  WorkerTask,
  ClusterNode,
  CircuitBreaker,
  AuditEntry,
  FireTriggerResponse,
  BulkResponse,
  BatchCreateResponse,
  HealthResponse,
  ResourcePool,
  PoolResource,
  Credential,
  SyncRequest,
  SyncResponse,
  RegisterDeviceRequest,
  ResolveApprovalRequest,
  CreateCommandRequest,
  CommandPayload,
  StatusUpdatePayload,
  MobileDevicesResponse,
  MobileApprovalsResponse,
  MobileStatusResponse,
  IngestTelemetryRequest,
  IngestErrorRequest,
  IngestResponse,
  DashboardQueryType,
  DashboardResponse,
  RollbackPolicy,
  CreatePolicyRequest,
  ApprovalItem,
  ApprovalsResponse,
  CreateInstanceRequest,
  UpdateStateRequest,
  UpdateContextRequest,
  SendSignalRequest,
  CreateCronRequest,
  UpdateCronRequest,
  CreateTriggerRequest,
  CreateCredentialRequest,
  UpdateCredentialRequest,
  CreateSessionRequest,
  CreatePoolRequest,
  AddResourceRequest,
  UpdateResourceRequest,
  PollRequest,
  QueuePollRequest,
  CompleteRequest,
  FailRequest,
  HeartbeatRequest,
  HeartbeatResponse,
} from "./types.js";
import { ContinuityClient } from "./continuity.js";

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export class Orch8Error extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    public readonly path: string,
  ) {
    super(`Orch8 API error ${status} on ${path}`);
    this.name = "Orch8Error";
  }
}

export class Orch8Client {
  private readonly baseUrl: string;
  private readonly tenantId?: string;
  private readonly namespace?: string;
  private readonly extraHeaders: Record<string, string>;
  private readonly getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  private readonly retryConfig: RetryConfig | false;
  private readonly timeoutMs: number;
  private readonly onRequest?: (event: RequestEvent) => void;
  private readonly onResponse?: (event: ResponseEvent) => void;
  /** Portable-continuity, policy, simulation, and federation operations. */
  public readonly continuity: ContinuityClient;

  constructor(config: Orch8ClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.tenantId = config.tenantId;
    this.namespace = config.namespace;
    this.extraHeaders = config.headers ?? {};
    this.getHeaders = config.getHeaders;
    this.retryConfig = config.retry === false
      ? false
      : { maxAttempts: 3, baseDelayMs: 250, ...(config.retry ?? {}) };
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.onRequest = config.onRequest;
    this.onResponse = config.onResponse;
    this.continuity = new ContinuityClient(this);
  }

  // ---------------------------------------------------------------------------
  // Internal HTTP helpers
  // ---------------------------------------------------------------------------

  private async buildHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    const dynamicHeaders = this.getHeaders ? await this.getHeaders() : {};
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...this.extraHeaders,
      ...dynamicHeaders,
      ...extra,
    };
    if (this.tenantId) {
      headers["X-Tenant-Id"] = this.tenantId;
    }
    return headers;
  }

  private e(segment: string): string {
    return encodeURIComponent(segment);
  }

  async request<T = unknown>(
    method: HttpMethod,
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new TypeError("Orch8 request paths must start with exactly one '/'");
    }
    const normalizedMethod = method.toUpperCase() as HttpMethod;
    const isSafe = normalizedMethod === "GET";
    const maxAttempts = this.retryConfig && isSafe
      ? Math.max(1, this.retryConfig.maxAttempts ?? 3)
      : 1;
    const baseDelayMs = this.retryConfig ? this.retryConfig.baseDelayMs ?? 250 : 0;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const event = { method: normalizedMethod, path, attempt, maxAttempts };
      const startedAt = Date.now();
      this.observe(this.onRequest, event);
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          const res = await fetch(`${this.baseUrl}${path}`, {
            method: normalizedMethod,
            headers: await this.buildHeaders(),
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: controller.signal,
          });

          const text = res.status === 204 ? "" : await res.text();
          const responseBody = text.length === 0 ? undefined : this.parseBody(text);
          if (!res.ok) {
            const error = new Orch8Error(res.status, responseBody, path);
            this.observe(this.onResponse, {
              ...event,
              status: res.status,
              durationMs: Date.now() - startedAt,
              error,
            });
            if (this.isRetryableStatus(res.status) && attempt < maxAttempts) {
              clearTimeout(timeout);
              await this.retry(error, attempt, baseDelayMs);
              continue;
            }
            throw error;
          }
          this.observe(this.onResponse, {
            ...event,
            status: res.status,
            durationMs: Date.now() - startedAt,
          });
          if (text.length === 0) return undefined as T;
          return JSON.parse(text) as T;
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        lastError = error;
        if (!(error instanceof Orch8Error)) {
          this.observe(this.onResponse, {
            ...event,
            durationMs: Date.now() - startedAt,
            error,
          });
        }
        if (error instanceof Orch8Error || attempt >= maxAttempts) throw error;
        await this.retry(error, attempt, baseDelayMs);
      }
    }
    throw lastError;
  }

  private observe<T>(observer: ((event: T) => void) | undefined, event: T): void {
    try {
      observer?.(event);
    } catch {
      // Observability must never change request behavior.
    }
  }

  async requestPage<T>(
    path: string,
    query?: Record<string, string>,
  ): Promise<Page<T>> {
    const separator = path.includes("?") ? "&" : "?";
    const suffix = query && Object.keys(query).length > 0
      ? `${separator}${new URLSearchParams(query)}`
      : "";
    const result = await this.request<T[] | Partial<Page<T>>>("GET", `${path}${suffix}`);
    if (Array.isArray(result)) return { items: result, next_cursor: null };
    return {
      items: result.items ?? [],
      next_cursor: result.next_cursor ?? null,
      ...(result.total === undefined ? {} : { total: result.total }),
    };
  }

  private parseBody(text: string): unknown {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private isRetryableStatus(status: number): boolean {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }

  private async retry(error: unknown, attempt: number, baseDelayMs: number): Promise<void> {
    if (this.retryConfig && this.retryConfig.onRetry) {
      this.retryConfig.onRetry(error, attempt + 1);
    }
    const delayMs = baseDelayMs * 2 ** (attempt - 1);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  private put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  private del<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  // ---------------------------------------------------------------------------
  // Sequences
  // ---------------------------------------------------------------------------

  createSequence(
    body: Record<string, unknown>,
  ): Promise<CreateSequenceResponse> {
    const tenantId = body.tenant_id ?? this.tenantId;
    if (typeof tenantId !== "string" || tenantId.length === 0) {
      return Promise.reject(new TypeError("tenant_id is required to create a sequence"));
    }
    const prepared = {
      ...body,
      id: body.id ?? randomUUID(),
      tenant_id: tenantId,
      namespace: body.namespace ?? this.namespace ?? "default",
      version: body.version ?? 1,
      deprecated: body.deprecated ?? false,
      status: body.status ?? "production",
      created_at: body.created_at ?? new Date().toISOString(),
    };
    return this.post<CreateSequenceResponse>("/sequences", prepared);
  }

  getSequence(id: string): Promise<SequenceDefinition> {
    return this.get<SequenceDefinition>(`/sequences/${this.e(id)}`);
  }

  getSequenceByName(
    tenantId: string,
    namespace: string,
    name: string,
    version?: number,
  ): Promise<SequenceDefinition> {
    const params = new URLSearchParams({ tenant_id: tenantId, namespace, name });
    if (version !== undefined) params.set("version", String(version));
    return this.get<SequenceDefinition>(`/sequences/by-name?${params}`);
  }

  deprecateSequence(id: string): Promise<void> {
    return this.post<void>(`/sequences/${this.e(id)}/deprecate`);
  }

  listSequenceVersions(
    tenantId: string,
    namespace: string,
    name: string,
  ): Promise<SequenceDefinition[]> {
    const params = new URLSearchParams({ tenant_id: tenantId, namespace, name });
    return this.get<SequenceDefinition[]>(`/sequences/versions?${params}`);
  }

  async listSequences(filter?: Record<string, string>): Promise<SequenceDefinition[]> {
    const params = filter ? `?${new URLSearchParams(filter)}` : "";
    const result = await this.get<SequenceDefinition[] | { items: SequenceDefinition[] }>(
      `/sequences${params}`,
    );
    return Array.isArray(result) ? result : result.items;
  }

  deleteSequence(id: string): Promise<void> {
    return this.del<void>(`/sequences/${this.e(id)}`);
  }

  migrateInstance(body: Record<string, unknown>): Promise<TaskInstance> {
    return this.post<TaskInstance>("/sequences/migrate-instance", body);
  }

  // ---------------------------------------------------------------------------
  // Instances
  // ---------------------------------------------------------------------------

  async createInstance(
    body: CreateInstanceRequest | Record<string, unknown>,
  ): Promise<TaskInstance> {
    return this.post<TaskInstance>("/instances", this.prepareInstance(body));
  }

  async batchCreateInstances(
    instances: Record<string, unknown>[],
  ): Promise<BatchCreateResponse> {
    // Engine contract: `{"instances": [...]}` — see
    // orch8-api::instances::BatchCreateRequest.
    const prepared = instances.map((instance) => this.prepareInstance(instance));
    return this.post<BatchCreateResponse>("/instances/batch", { instances: prepared });
  }

  getInstance(id: string): Promise<TaskInstance> {
    return this.get<TaskInstance>(`/instances/${this.e(id)}`);
  }

  async listInstances(filter?: Record<string, string>): Promise<TaskInstance[]> {
    const params = filter ? `?${new URLSearchParams(filter)}` : "";
    const result = await this.get<TaskInstance[] | { items: TaskInstance[] }>(
      `/instances${params}`,
    );
    return Array.isArray(result) ? result : result.items;
  }

  private prepareInstance(
    body: CreateInstanceRequest | Record<string, unknown>,
  ): Record<string, unknown> {
    const tenantId = body.tenant_id ?? this.tenantId;
    if (typeof tenantId !== "string" || tenantId.length === 0) {
      throw new TypeError("tenant_id is required to create an instance");
    }
    return {
      ...body,
      tenant_id: tenantId,
      namespace: body.namespace ?? this.namespace ?? "default",
    };
  }

  // Engine returns 200 with an empty body — no TaskInstance is sent back.
  // Callers who need the updated instance should call `getInstance(id)`.
  updateInstanceState(
    id: string,
    body: UpdateStateRequest | Record<string, unknown>,
  ): Promise<void> {
    return this.patch<void>(`/instances/${this.e(id)}/state`, body);
  }

  // Engine returns 200 with an empty body.
  updateInstanceContext(
    id: string,
    body: UpdateContextRequest | Record<string, unknown>,
  ): Promise<void> {
    return this.patch<void>(`/instances/${this.e(id)}/context`, body);
  }

  // Engine returns 201 with `{"signal_id": <uuid>}` — preserve it so callers
  // can correlate the enqueued signal with downstream delivery events.
  sendSignal(
    id: string,
    body: SendSignalRequest | Record<string, unknown>,
  ): Promise<{ signal_id: string }> {
    return this.post<{ signal_id: string }>(`/instances/${this.e(id)}/signals`, body);
  }

  getOutputs(id: string): Promise<StepOutput[]> {
    return this.get<StepOutput[]>(`/instances/${this.e(id)}/outputs`);
  }

  getExecutionTree(id: string): Promise<ExecutionNode[]> {
    return this.get<ExecutionNode[]>(`/instances/${this.e(id)}/tree`);
  }

  retryInstance(id: string): Promise<TaskInstance> {
    return this.post<TaskInstance>(`/instances/${this.e(id)}/retry`);
  }

  listCheckpoints(id: string): Promise<Checkpoint[]> {
    return this.get<Checkpoint[]>(`/instances/${this.e(id)}/checkpoints`);
  }

  saveCheckpoint(
    id: string,
    body: Record<string, unknown>,
  ): Promise<Checkpoint> {
    return this.post<Checkpoint>(`/instances/${this.e(id)}/checkpoints`, body);
  }

  getLatestCheckpoint(id: string): Promise<Checkpoint> {
    return this.get<Checkpoint>(`/instances/${this.e(id)}/checkpoints/latest`);
  }

  pruneCheckpoints(
    id: string,
    body?: Record<string, unknown>,
  ): Promise<void> {
    return this.post<void>(`/instances/${this.e(id)}/checkpoints/prune`, body);
  }

  listAuditLog(id: string): Promise<AuditEntry[]> {
    return this.get<AuditEntry[]>(`/instances/${this.e(id)}/audit`);
  }

  injectBlocks(id: string, body: Record<string, unknown>): Promise<void> {
    return this.post<void>(`/instances/${this.e(id)}/inject-blocks`, body);
  }

  async *streamInstance(
    id: string,
    options?: InstanceStreamOptions,
  ): AsyncGenerator<Record<string, unknown>> {
    for await (const event of this.streamInstanceEvents(id, options)) {
      yield event.data;
    }
  }

  async *streamInstanceEvents(
    id: string,
    options: InstanceStreamOptions = {},
  ): AsyncGenerator<InstanceStreamEvent> {
    const pollMs = options.pollMs === undefined
      ? undefined
      : Math.max(100, Math.min(options.pollMs, 5000));
    const query = pollMs === undefined ? "" : `?${new URLSearchParams({ poll_ms: String(pollMs) })}`;
    const path = `/instances/${this.e(id)}/stream${query}`;
    const headers = await this.buildHeaders({
      Accept: "text/event-stream",
      ...(options.lastEventId ? { "Last-Event-ID": options.lastEventId } : {}),
    });
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers,
      signal: options.signal,
    });

    if (!res.ok) {
      let resBody: unknown;
      try {
        resBody = await res.json();
      } catch {
        resBody = await res.text().catch(() => null);
      }
      throw new Orch8Error(res.status, resBody, path);
    }

    const reader = res.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = "";
    let eventId: string | undefined;
    let eventType: string | undefined;
    let eventData: string[] = [];

    const parseEvent = (): InstanceStreamEvent | undefined => {
      if (eventData.length === 0) return undefined;
      const raw = eventData.join("\n");
      eventData = [];
      if (!raw || raw === "[DONE]") return undefined;
      try {
        const event = { id: eventId, event: eventType, data: JSON.parse(raw) as Record<string, unknown> };
        eventId = undefined;
        eventType = undefined;
        return event;
      } catch {
        return undefined;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("id:")) eventId = line.slice(3).trim();
          else if (line.startsWith("event:")) eventType = line.slice(6).trim();
          else if (line.startsWith("data:")) eventData.push(line.slice(5).trimStart());
          else if (line.trim() === "") {
            const event = parseEvent();
            if (event) yield event;
          }
        }
      }
      const event = parseEvent();
      if (event) yield event;
    } finally {
      reader.releaseLock();
    }
  }

  bulkUpdateState(body: Record<string, unknown>): Promise<BulkResponse> {
    return this.patch<BulkResponse>("/instances/bulk/state", body);
  }

  bulkReschedule(body: Record<string, unknown>): Promise<BulkResponse> {
    return this.patch<BulkResponse>("/instances/bulk/reschedule", body);
  }

  listDLQ(filter?: Record<string, string>): Promise<TaskInstance[]> {
    const params = filter ? `?${new URLSearchParams(filter)}` : "";
    return this.get<TaskInstance[]>(`/instances/dlq${params}`);
  }

  // ---------------------------------------------------------------------------
  // Approvals
  // ---------------------------------------------------------------------------

  listApprovals(
    filter?: Record<string, string>,
  ): Promise<ApprovalsResponse> {
    const params = filter ? `?${new URLSearchParams(filter)}` : "";
    return this.get<ApprovalsResponse>(`/approvals${params}`);
  }

  // ---------------------------------------------------------------------------
  // Cron
  // ---------------------------------------------------------------------------

  createCron(
    body: CreateCronRequest | Record<string, unknown>,
  ): Promise<CronSchedule> {
    return this.post<CronSchedule>("/cron", body);
  }

  listCron(tenantId?: string): Promise<CronSchedule[]> {
    const params = tenantId
      ? `?${new URLSearchParams({ tenant_id: tenantId })}`
      : "";
    return this.get<CronSchedule[]>(`/cron${params}`);
  }

  getCron(id: string): Promise<CronSchedule> {
    return this.get<CronSchedule>(`/cron/${this.e(id)}`);
  }

  updateCron(
    id: string,
    body: UpdateCronRequest | Record<string, unknown>,
  ): Promise<CronSchedule> {
    return this.put<CronSchedule>(`/cron/${this.e(id)}`, body);
  }

  deleteCron(id: string): Promise<void> {
    return this.del<void>(`/cron/${this.e(id)}`);
  }

  // ---------------------------------------------------------------------------
  // Triggers
  // ---------------------------------------------------------------------------

  createTrigger(
    body: CreateTriggerRequest | Record<string, unknown>,
  ): Promise<TriggerDef> {
    return this.post<TriggerDef>("/triggers", body);
  }

  listTriggers(tenantId?: string): Promise<TriggerDef[]> {
    const params = tenantId
      ? `?${new URLSearchParams({ tenant_id: tenantId })}`
      : "";
    return this.get<TriggerDef[]>(`/triggers${params}`);
  }

  getTrigger(slug: string): Promise<TriggerDef> {
    return this.get<TriggerDef>(`/triggers/${this.e(slug)}`);
  }

  deleteTrigger(slug: string): Promise<void> {
    return this.del<void>(`/triggers/${this.e(slug)}`);
  }

  fireTrigger(
    slug: string,
    body?: Record<string, unknown>,
  ): Promise<FireTriggerResponse> {
    return this.post<FireTriggerResponse>(`/triggers/${this.e(slug)}/fire`, body);
  }

  // ---------------------------------------------------------------------------
  // Plugins
  // ---------------------------------------------------------------------------

  createPlugin(body: Record<string, unknown>): Promise<PluginDef> {
    return this.post<PluginDef>("/plugins", body);
  }

  listPlugins(tenantId?: string): Promise<PluginDef[]> {
    const params = tenantId
      ? `?${new URLSearchParams({ tenant_id: tenantId })}`
      : "";
    return this.get<PluginDef[]>(`/plugins${params}`);
  }

  getPlugin(name: string): Promise<PluginDef> {
    return this.get<PluginDef>(`/plugins/${this.e(name)}`);
  }

  updatePlugin(
    name: string,
    body: Record<string, unknown>,
  ): Promise<PluginDef> {
    return this.patch<PluginDef>(`/plugins/${this.e(name)}`, body);
  }

  deletePlugin(name: string): Promise<void> {
    return this.del<void>(`/plugins/${this.e(name)}`);
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  createSession(
    body: CreateSessionRequest | Record<string, unknown>,
  ): Promise<Session> {
    return this.post<Session>("/sessions", body);
  }

  getSession(id: string): Promise<Session> {
    return this.get<Session>(`/sessions/${this.e(id)}`);
  }

  getSessionByKey(tenantId: string, key: string): Promise<Session> {
    return this.get<Session>(`/sessions/by-key/${this.e(tenantId)}/${this.e(key)}`);
  }

  updateSessionData(
    id: string,
    body: Record<string, unknown>,
  ): Promise<Session> {
    return this.patch<Session>(`/sessions/${this.e(id)}/data`, body);
  }

  updateSessionState(
    id: string,
    body: Record<string, unknown>,
  ): Promise<Session> {
    return this.patch<Session>(`/sessions/${this.e(id)}/state`, body);
  }

  listSessionInstances(id: string): Promise<TaskInstance[]> {
    return this.get<TaskInstance[]>(`/sessions/${this.e(id)}/instances`);
  }

  // ---------------------------------------------------------------------------
  // Workers
  // ---------------------------------------------------------------------------

  pollTasks(
    body: PollRequest | Record<string, unknown>,
  ): Promise<WorkerTask[]> {
    return this.post<WorkerTask[]>("/workers/tasks/poll", body);
  }

  completeTask(
    id: string,
    body: CompleteRequest | Record<string, unknown>,
  ): Promise<void> {
    return this.post<void>(`/workers/tasks/${this.e(id)}/complete`, body);
  }

  failTask(
    id: string,
    body: FailRequest | Record<string, unknown>,
  ): Promise<void> {
    return this.post<void>(`/workers/tasks/${this.e(id)}/fail`, body);
  }

  heartbeatTask(
    id: string,
    body: HeartbeatRequest | Record<string, unknown>,
  ): Promise<HeartbeatResponse> {
    if ("checkpoint" in body && body.checkpoint !== undefined && body.checkpoint_seq === undefined) {
      return Promise.reject(new TypeError("checkpoint_seq is required with checkpoint"));
    }
    return this.post<HeartbeatResponse>(`/workers/tasks/${this.e(id)}/heartbeat`, body);
  }

  listWorkerTasks(filter?: Record<string, string>): Promise<WorkerTask[]> {
    const params = filter ? `?${new URLSearchParams(filter)}` : "";
    return this.get<WorkerTask[]>(`/workers/tasks${params}`);
  }

  getWorkerTaskStats(): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>("/workers/tasks/stats");
  }

  pollTasksFromQueue(
    body: QueuePollRequest | Record<string, unknown>,
  ): Promise<WorkerTask[]> {
    return this.post<WorkerTask[]>("/workers/tasks/poll/queue", body);
  }

  // ---------------------------------------------------------------------------
  // Cluster
  // ---------------------------------------------------------------------------

  listClusterNodes(): Promise<ClusterNode[]> {
    return this.get<ClusterNode[]>("/cluster/nodes");
  }

  drainNode(id: string): Promise<void> {
    return this.post<void>(`/cluster/nodes/${this.e(id)}/drain`);
  }

  // ---------------------------------------------------------------------------
  // Circuit Breakers
  // ---------------------------------------------------------------------------

  listCircuitBreakers(): Promise<CircuitBreaker[]> {
    return this.get<CircuitBreaker[]>("/circuit-breakers");
  }

  getCircuitBreaker(handler: string): Promise<CircuitBreaker> {
    return this.get<CircuitBreaker>(`/circuit-breakers/${this.e(handler)}`);
  }

  resetCircuitBreaker(handler: string): Promise<void> {
    return this.post<void>(`/circuit-breakers/${this.e(handler)}/reset`);
  }

  // ---------------------------------------------------------------------------
  // Circuit Breakers (per-tenant)
  // ---------------------------------------------------------------------------

  listTenantCircuitBreakers(tenantId: string): Promise<CircuitBreaker[]> {
    return this.get<CircuitBreaker[]>(`/tenants/${this.e(tenantId)}/circuit-breakers`);
  }

  getTenantCircuitBreaker(
    tenantId: string,
    handler: string,
  ): Promise<CircuitBreaker> {
    return this.get<CircuitBreaker>(
      `/tenants/${this.e(tenantId)}/circuit-breakers/${this.e(handler)}`,
    );
  }

  resetTenantCircuitBreaker(
    tenantId: string,
    handler: string,
  ): Promise<void> {
    return this.post<void>(
      `/tenants/${this.e(tenantId)}/circuit-breakers/${this.e(handler)}/reset`,
    );
  }

  // ---------------------------------------------------------------------------
  // Resource Pools
  // ---------------------------------------------------------------------------

  listPools(tenantId?: string): Promise<ResourcePool[]> {
    const params = tenantId
      ? `?${new URLSearchParams({ tenant_id: tenantId })}`
      : "";
    return this.get<ResourcePool[]>(`/pools${params}`);
  }

  createPool(
    body: CreatePoolRequest | Record<string, unknown>,
  ): Promise<ResourcePool> {
    return this.post<ResourcePool>("/pools", body);
  }

  getPool(id: string): Promise<ResourcePool> {
    return this.get<ResourcePool>(`/pools/${this.e(id)}`);
  }

  deletePool(id: string): Promise<void> {
    return this.del<void>(`/pools/${this.e(id)}`);
  }

  listPoolResources(poolId: string): Promise<PoolResource[]> {
    return this.get<PoolResource[]>(`/pools/${this.e(poolId)}/resources`);
  }

  createPoolResource(
    poolId: string,
    body: AddResourceRequest | Record<string, unknown>,
  ): Promise<PoolResource> {
    return this.post<PoolResource>(`/pools/${this.e(poolId)}/resources`, body);
  }

  updatePoolResource(
    poolId: string,
    resourceId: string,
    body: UpdateResourceRequest | Record<string, unknown>,
  ): Promise<PoolResource> {
    return this.put<PoolResource>(
      `/pools/${this.e(poolId)}/resources/${this.e(resourceId)}`,
      body,
    );
  }

  deletePoolResource(poolId: string, resourceId: string): Promise<void> {
    return this.del<void>(`/pools/${this.e(poolId)}/resources/${this.e(resourceId)}`);
  }

  // ---------------------------------------------------------------------------
  // Credentials
  // ---------------------------------------------------------------------------

  listCredentials(tenantId?: string): Promise<Credential[]> {
    const params = tenantId
      ? `?${new URLSearchParams({ tenant_id: tenantId })}`
      : "";
    return this.get<Credential[]>(`/credentials${params}`);
  }

  createCredential(
    body: CreateCredentialRequest | Record<string, unknown>,
  ): Promise<Credential> {
    return this.post<Credential>("/credentials", body);
  }

  getCredential(id: string): Promise<Credential> {
    return this.get<Credential>(`/credentials/${this.e(id)}`);
  }

  deleteCredential(id: string): Promise<void> {
    return this.del<void>(`/credentials/${this.e(id)}`);
  }

  updateCredential(
    id: string,
    body: UpdateCredentialRequest | Record<string, unknown>,
  ): Promise<Credential> {
    return this.patch<Credential>(`/credentials/${this.e(id)}`, body);
  }

  // ---------------------------------------------------------------------------
  // Mobile Sync
  // ---------------------------------------------------------------------------

  mobileSync(body: SyncRequest): Promise<SyncResponse> {
    return this.post<SyncResponse>("/mobile/sync", body);
  }

  registerMobileDevice(body: RegisterDeviceRequest): Promise<void> {
    return this.post<void>("/mobile/devices/register", body);
  }

  listMobileDevices(): Promise<MobileDevicesResponse> {
    return this.get<MobileDevicesResponse>("/mobile/devices");
  }

  listMobileApprovals(): Promise<MobileApprovalsResponse> {
    return this.get<MobileApprovalsResponse>("/mobile/approvals");
  }

  resolveMobileApproval(
    id: string,
    body: ResolveApprovalRequest,
  ): Promise<void> {
    return this.post<void>(`/mobile/approvals/${this.e(id)}/resolve`, body);
  }

  listMobileStatus(): Promise<MobileStatusResponse> {
    return this.get<MobileStatusResponse>("/mobile/status");
  }

  createMobileCommand(body: CreateCommandRequest): Promise<void> {
    return this.post<void>("/mobile/commands", body);
  }

  // ---------------------------------------------------------------------------
  // Telemetry
  // ---------------------------------------------------------------------------

  ingestTelemetry(body: IngestTelemetryRequest): Promise<IngestResponse> {
    return this.post<IngestResponse>("/telemetry/mobile", body);
  }

  ingestTelemetryError(body: IngestErrorRequest): Promise<IngestResponse> {
    return this.post<IngestResponse>("/telemetry/mobile/errors", body);
  }

  telemetryDashboard(
    queryType: DashboardQueryType,
    tenantId?: string,
    startTime?: string,
    endTime?: string,
  ): Promise<DashboardResponse> {
    const params = new URLSearchParams({ query_type: queryType });
    if (tenantId) params.set("tenant_id", tenantId);
    if (startTime) params.set("start_time", startTime);
    if (endTime) params.set("end_time", endTime);
    return this.get<DashboardResponse>(`/telemetry/mobile/dashboard?${params}`);
  }

  // ---------------------------------------------------------------------------
  // Rollback Policies
  // ---------------------------------------------------------------------------

  createRollbackPolicy(body: CreatePolicyRequest): Promise<RollbackPolicy> {
    return this.post<RollbackPolicy>("/rollback-policies", body);
  }

  listRollbackPolicies(tenantId?: string): Promise<RollbackPolicy[]> {
    const params = tenantId
      ? `?${new URLSearchParams({ tenant_id: tenantId })}`
      : "";
    return this.get<RollbackPolicy[]>(`/rollback-policies${params}`);
  }

  getRollbackPolicy(name: string): Promise<RollbackPolicy> {
    return this.get<RollbackPolicy>(`/rollback-policies/${this.e(name)}`);
  }

  deleteRollbackPolicy(name: string): Promise<void> {
    return this.del<void>(`/rollback-policies/${this.e(name)}`);
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  health(): Promise<HealthResponse> {
    return this.get<HealthResponse>("/health/ready");
  }
}
