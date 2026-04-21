import type {
  Orch8ClientConfig,
  SequenceDefinition,
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
} from "./types.js";

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

  constructor(config: Orch8ClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.tenantId = config.tenantId;
    this.namespace = config.namespace;
    this.extraHeaders = config.headers ?? {};
  }

  // ---------------------------------------------------------------------------
  // Internal HTTP helpers
  // ---------------------------------------------------------------------------

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.extraHeaders,
      ...extra,
    };
    if (this.tenantId) {
      headers["X-Tenant-Id"] = this.tenantId;
    }
    return headers;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.buildHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
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

    if (res.status === 204) {
      return undefined as T;
    }

    // The engine returns 200 with an empty body on several handlers
    // (update_state, update_context, deprecate_sequence, drain_node, etc.).
    // `res.json()` would throw on an empty body; fall back to a text read
    // and return undefined when nothing came back.
    const text = await res.text();
    if (text.length === 0) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
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

  createSequence(body: Record<string, unknown>): Promise<SequenceDefinition> {
    return this.post<SequenceDefinition>("/sequences", body);
  }

  getSequence(id: string): Promise<SequenceDefinition> {
    return this.get<SequenceDefinition>(`/sequences/${id}`);
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
    return this.post<void>(`/sequences/${id}/deprecate`);
  }

  listSequenceVersions(
    tenantId: string,
    namespace: string,
    name: string,
  ): Promise<SequenceDefinition[]> {
    const params = new URLSearchParams({ tenant_id: tenantId, namespace, name });
    return this.get<SequenceDefinition[]>(`/sequences/versions?${params}`);
  }

  listSequences(filter?: Record<string, string>): Promise<SequenceDefinition[]> {
    const params = filter ? `?${new URLSearchParams(filter)}` : "";
    return this.get<SequenceDefinition[]>(`/sequences${params}`);
  }

  deleteSequence(id: string): Promise<void> {
    return this.del<void>(`/sequences/${id}`);
  }

  migrateInstance(body: Record<string, unknown>): Promise<TaskInstance> {
    return this.post<TaskInstance>("/sequences/migrate-instance", body);
  }

  // ---------------------------------------------------------------------------
  // Instances
  // ---------------------------------------------------------------------------

  createInstance(body: Record<string, unknown>): Promise<TaskInstance> {
    return this.post<TaskInstance>("/instances", body);
  }

  batchCreateInstances(
    instances: Record<string, unknown>[],
  ): Promise<BatchCreateResponse> {
    // Engine contract: `{"instances": [...]}` — see
    // orch8-api::instances::BatchCreateRequest.
    return this.post<BatchCreateResponse>("/instances/batch", { instances });
  }

  getInstance(id: string): Promise<TaskInstance> {
    return this.get<TaskInstance>(`/instances/${id}`);
  }

  listInstances(filter?: Record<string, string>): Promise<TaskInstance[]> {
    const params = filter ? `?${new URLSearchParams(filter)}` : "";
    return this.get<TaskInstance[]>(`/instances${params}`);
  }

  // Engine returns 200 with an empty body — no TaskInstance is sent back.
  // Callers who need the updated instance should call `getInstance(id)`.
  updateInstanceState(
    id: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    return this.patch<void>(`/instances/${id}/state`, body);
  }

  // Engine returns 200 with an empty body.
  updateInstanceContext(
    id: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    return this.patch<void>(`/instances/${id}/context`, body);
  }

  // Engine returns 201 with `{"signal_id": <uuid>}` — preserve it so callers
  // can correlate the enqueued signal with downstream delivery events.
  sendSignal(
    id: string,
    body: Record<string, unknown>,
  ): Promise<{ signal_id: string }> {
    return this.post<{ signal_id: string }>(`/instances/${id}/signals`, body);
  }

  getOutputs(id: string): Promise<StepOutput[]> {
    return this.get<StepOutput[]>(`/instances/${id}/outputs`);
  }

  getExecutionTree(id: string): Promise<ExecutionNode[]> {
    return this.get<ExecutionNode[]>(`/instances/${id}/tree`);
  }

  retryInstance(id: string): Promise<TaskInstance> {
    return this.post<TaskInstance>(`/instances/${id}/retry`);
  }

  listCheckpoints(id: string): Promise<Checkpoint[]> {
    return this.get<Checkpoint[]>(`/instances/${id}/checkpoints`);
  }

  saveCheckpoint(
    id: string,
    body: Record<string, unknown>,
  ): Promise<Checkpoint> {
    return this.post<Checkpoint>(`/instances/${id}/checkpoints`, body);
  }

  getLatestCheckpoint(id: string): Promise<Checkpoint> {
    return this.get<Checkpoint>(`/instances/${id}/checkpoints/latest`);
  }

  pruneCheckpoints(
    id: string,
    body?: Record<string, unknown>,
  ): Promise<void> {
    return this.post<void>(`/instances/${id}/checkpoints/prune`, body);
  }

  listAuditLog(id: string): Promise<AuditEntry[]> {
    return this.get<AuditEntry[]>(`/instances/${id}/audit`);
  }

  injectBlocks(id: string, body: Record<string, unknown>): Promise<void> {
    return this.post<void>(`/instances/${id}/inject-blocks`, body);
  }

  async *streamInstance(
    id: string,
  ): AsyncGenerator<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/instances/${id}/stream`, {
      method: "GET",
      headers: this.buildHeaders({ Accept: "text/event-stream" }),
    });

    if (!res.ok) {
      let resBody: unknown;
      try {
        resBody = await res.json();
      } catch {
        resBody = await res.text().catch(() => null);
      }
      throw new Orch8Error(res.status, resBody, `/instances/${id}/stream`);
    }

    const reader = res.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data:")) {
            const data = trimmed.slice(5).trim();
            if (data && data !== "[DONE]") {
              try {
                yield JSON.parse(data) as Record<string, unknown>;
              } catch {
                // Skip non-JSON data lines.
              }
            }
          }
        }
      }
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

  listApprovals(filter?: Record<string, string>): Promise<TaskInstance[]> {
    const params = filter ? `?${new URLSearchParams(filter)}` : "";
    return this.get<TaskInstance[]>(`/approvals${params}`);
  }

  // ---------------------------------------------------------------------------
  // Cron
  // ---------------------------------------------------------------------------

  createCron(body: Record<string, unknown>): Promise<CronSchedule> {
    return this.post<CronSchedule>("/cron", body);
  }

  listCron(tenantId?: string): Promise<CronSchedule[]> {
    const params = tenantId
      ? `?${new URLSearchParams({ tenant_id: tenantId })}`
      : "";
    return this.get<CronSchedule[]>(`/cron${params}`);
  }

  getCron(id: string): Promise<CronSchedule> {
    return this.get<CronSchedule>(`/cron/${id}`);
  }

  updateCron(
    id: string,
    body: Record<string, unknown>,
  ): Promise<CronSchedule> {
    return this.put<CronSchedule>(`/cron/${id}`, body);
  }

  deleteCron(id: string): Promise<void> {
    return this.del<void>(`/cron/${id}`);
  }

  // ---------------------------------------------------------------------------
  // Triggers
  // ---------------------------------------------------------------------------

  createTrigger(body: Record<string, unknown>): Promise<TriggerDef> {
    return this.post<TriggerDef>("/triggers", body);
  }

  listTriggers(tenantId?: string): Promise<TriggerDef[]> {
    const params = tenantId
      ? `?${new URLSearchParams({ tenant_id: tenantId })}`
      : "";
    return this.get<TriggerDef[]>(`/triggers${params}`);
  }

  getTrigger(slug: string): Promise<TriggerDef> {
    return this.get<TriggerDef>(`/triggers/${slug}`);
  }

  deleteTrigger(slug: string): Promise<void> {
    return this.del<void>(`/triggers/${slug}`);
  }

  fireTrigger(
    slug: string,
    body?: Record<string, unknown>,
  ): Promise<FireTriggerResponse> {
    return this.post<FireTriggerResponse>(`/triggers/${slug}/fire`, body);
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
    return this.get<PluginDef>(`/plugins/${name}`);
  }

  updatePlugin(
    name: string,
    body: Record<string, unknown>,
  ): Promise<PluginDef> {
    return this.patch<PluginDef>(`/plugins/${name}`, body);
  }

  deletePlugin(name: string): Promise<void> {
    return this.del<void>(`/plugins/${name}`);
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  createSession(body: Record<string, unknown>): Promise<Session> {
    return this.post<Session>("/sessions", body);
  }

  getSession(id: string): Promise<Session> {
    return this.get<Session>(`/sessions/${id}`);
  }

  getSessionByKey(tenantId: string, key: string): Promise<Session> {
    return this.get<Session>(`/sessions/by-key/${tenantId}/${key}`);
  }

  updateSessionData(
    id: string,
    body: Record<string, unknown>,
  ): Promise<Session> {
    return this.patch<Session>(`/sessions/${id}/data`, body);
  }

  updateSessionState(
    id: string,
    body: Record<string, unknown>,
  ): Promise<Session> {
    return this.patch<Session>(`/sessions/${id}/state`, body);
  }

  listSessionInstances(id: string): Promise<TaskInstance[]> {
    return this.get<TaskInstance[]>(`/sessions/${id}/instances`);
  }

  // ---------------------------------------------------------------------------
  // Workers
  // ---------------------------------------------------------------------------

  pollTasks(body: Record<string, unknown>): Promise<WorkerTask[]> {
    return this.post<WorkerTask[]>("/workers/tasks/poll", body);
  }

  completeTask(
    id: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    return this.post<void>(`/workers/tasks/${id}/complete`, body);
  }

  failTask(id: string, body: Record<string, unknown>): Promise<void> {
    return this.post<void>(`/workers/tasks/${id}/fail`, body);
  }

  heartbeatTask(
    id: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    return this.post<void>(`/workers/tasks/${id}/heartbeat`, body);
  }

  listWorkerTasks(filter?: Record<string, string>): Promise<WorkerTask[]> {
    const params = filter ? `?${new URLSearchParams(filter)}` : "";
    return this.get<WorkerTask[]>(`/workers/tasks${params}`);
  }

  getWorkerTaskStats(): Promise<Record<string, unknown>> {
    return this.get<Record<string, unknown>>("/workers/tasks/stats");
  }

  pollTasksFromQueue(body: Record<string, unknown>): Promise<WorkerTask[]> {
    return this.post<WorkerTask[]>("/workers/tasks/poll/queue", body);
  }

  // ---------------------------------------------------------------------------
  // Cluster
  // ---------------------------------------------------------------------------

  listClusterNodes(): Promise<ClusterNode[]> {
    return this.get<ClusterNode[]>("/cluster/nodes");
  }

  drainNode(id: string): Promise<void> {
    return this.post<void>(`/cluster/nodes/${id}/drain`);
  }

  // ---------------------------------------------------------------------------
  // Circuit Breakers
  // ---------------------------------------------------------------------------

  listCircuitBreakers(): Promise<CircuitBreaker[]> {
    return this.get<CircuitBreaker[]>("/circuit-breakers");
  }

  getCircuitBreaker(handler: string): Promise<CircuitBreaker> {
    return this.get<CircuitBreaker>(`/circuit-breakers/${handler}`);
  }

  resetCircuitBreaker(handler: string): Promise<void> {
    return this.post<void>(`/circuit-breakers/${handler}/reset`);
  }

  // ---------------------------------------------------------------------------
  // Circuit Breakers (per-tenant)
  // ---------------------------------------------------------------------------

  listTenantCircuitBreakers(tenantId: string): Promise<CircuitBreaker[]> {
    return this.get<CircuitBreaker[]>(`/tenants/${tenantId}/circuit-breakers`);
  }

  getTenantCircuitBreaker(
    tenantId: string,
    handler: string,
  ): Promise<CircuitBreaker> {
    return this.get<CircuitBreaker>(
      `/tenants/${tenantId}/circuit-breakers/${handler}`,
    );
  }

  resetTenantCircuitBreaker(
    tenantId: string,
    handler: string,
  ): Promise<void> {
    return this.post<void>(
      `/tenants/${tenantId}/circuit-breakers/${handler}/reset`,
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

  createPool(body: Record<string, unknown>): Promise<ResourcePool> {
    return this.post<ResourcePool>("/pools", body);
  }

  getPool(id: string): Promise<ResourcePool> {
    return this.get<ResourcePool>(`/pools/${id}`);
  }

  deletePool(id: string): Promise<void> {
    return this.del<void>(`/pools/${id}`);
  }

  listPoolResources(poolId: string): Promise<PoolResource[]> {
    return this.get<PoolResource[]>(`/pools/${poolId}/resources`);
  }

  createPoolResource(
    poolId: string,
    body: Record<string, unknown>,
  ): Promise<PoolResource> {
    return this.post<PoolResource>(`/pools/${poolId}/resources`, body);
  }

  updatePoolResource(
    poolId: string,
    resourceId: string,
    body: Record<string, unknown>,
  ): Promise<PoolResource> {
    return this.put<PoolResource>(
      `/pools/${poolId}/resources/${resourceId}`,
      body,
    );
  }

  deletePoolResource(poolId: string, resourceId: string): Promise<void> {
    return this.del<void>(`/pools/${poolId}/resources/${resourceId}`);
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

  createCredential(body: Record<string, unknown>): Promise<Credential> {
    return this.post<Credential>("/credentials", body);
  }

  getCredential(id: string): Promise<Credential> {
    return this.get<Credential>(`/credentials/${id}`);
  }

  deleteCredential(id: string): Promise<void> {
    return this.del<void>(`/credentials/${id}`);
  }

  updateCredential(
    id: string,
    body: Record<string, unknown>,
  ): Promise<Credential> {
    return this.patch<Credential>(`/credentials/${id}`, body);
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  health(): Promise<HealthResponse> {
    return this.get<HealthResponse>("/health/ready");
  }
}
