import type { Orch8Client } from "./client.js";

export type JsonObject = Record<string, unknown>;
export type QueryValue = string | number | boolean | null | undefined;

function query(values: Record<string, QueryValue>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Typed-path wrappers for the engine's portable-continuity control plane.
 * Complex request/response bodies intentionally remain open JSON objects: the
 * engine publishes their complete schema through OpenAPI and evolves this
 * experimental surface faster than the stable workflow primitives.
 */
export class ContinuityClient {
  constructor(private readonly client: Orch8Client) {}

  createExecution(body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", "/continuity/executions", body);
  }

  getExecution(id: string, tenantId: string): Promise<JsonObject> {
    return this.client.request(
      "GET",
      `/continuity/executions/${segment(id)}${query({ tenant_id: tenantId })}`,
    );
  }

  listLocations(id: string, tenantId: string): Promise<JsonObject[]> {
    return this.client.request(
      "GET",
      `/continuity/executions/${segment(id)}/locations${query({ tenant_id: tenantId })}`,
    );
  }

  registerRuntime(body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", "/runtimes/register", body);
  }

  listRuntimes(tenantId: string): Promise<JsonObject[]> {
    return this.client.request("GET", `/runtimes${query({ tenant_id: tenantId })}`);
  }

  previewHandoff(id: string, body: JsonObject): Promise<JsonObject> {
    return this.client.request(
      "POST",
      `/continuity/executions/${segment(id)}/handoff-preview`,
      body,
    );
  }

  createHandoff(body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", "/continuity/handoffs", body);
  }

  getHandoff(id: string, tenantId: string): Promise<JsonObject> {
    return this.client.request(
      "GET",
      `/continuity/handoffs/${segment(id)}${query({ tenant_id: tenantId })}`,
    );
  }

  exportHandoff(id: string, body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", `/continuity/handoffs/${segment(id)}/export`, body);
  }

  attachDeviceCapsule(id: string, body: JsonObject): Promise<JsonObject> {
    return this.client.request(
      "POST",
      `/continuity/handoffs/${segment(id)}/attach-device-capsule`,
      body,
    );
  }

  acceptHandoff(id: string, body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", `/continuity/handoffs/${segment(id)}/accept`, body);
  }

  rejectHandoff(id: string, body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", `/continuity/handoffs/${segment(id)}/reject`, body);
  }

  resumeHandoff(id: string, body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", `/continuity/handoffs/${segment(id)}/resume`, body);
  }

  revokeHandoff(id: string, body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", `/continuity/handoffs/${segment(id)}/revoke`, body);
  }

  importCapsule(body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", "/continuity/capsules/import", body);
  }

  issueGrant(body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", "/continuity/grants", body);
  }

  consumeGrant(body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", "/continuity/grants/consume", body);
  }

  listEffects(id: string, tenantId: string): Promise<JsonObject[]> {
    return this.client.request(
      "GET",
      `/continuity/executions/${segment(id)}/effects${query({ tenant_id: tenantId })}`,
    );
  }

  resolveEffect(id: string, body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", `/continuity/effects/${segment(id)}/resolve`, body);
  }

  listProvenance(id: string, tenantId: string): Promise<JsonObject[]> {
    return this.client.request(
      "GET",
      `/continuity/executions/${segment(id)}/provenance${query({ tenant_id: tenantId })}`,
    );
  }

  recordProvenance(id: string, body: JsonObject): Promise<JsonObject> {
    return this.client.request(
      "POST",
      `/continuity/executions/${segment(id)}/provenance`,
      body,
    );
  }

  verifyProvenance(id: string, tenantId: string, expectedHead?: string): Promise<JsonObject> {
    return this.client.request(
      "GET",
      `/continuity/executions/${segment(id)}/provenance/verify${query({
        tenant_id: tenantId,
        expected_head: expectedHead,
      })}`,
    );
  }

  choosePlacement(id: string, body: JsonObject): Promise<JsonObject> {
    return this.client.request(
      "POST",
      `/continuity/executions/${segment(id)}/placement`,
      body,
    );
  }

  createStream(body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", "/continuity/streams", body);
  }

  appendFrame(id: string, body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", `/continuity/streams/${segment(id)}/frames`, body);
  }

  listFrames(id: string, tenantId: string, afterSequence?: number): Promise<JsonObject[]> {
    return this.client.request(
      "GET",
      `/continuity/streams/${segment(id)}/frames${query({
        tenant_id: tenantId,
        after_sequence: afterSequence,
      })}`,
    );
  }

  listWindows(
    id: string,
    tenantId: string,
    kind: "tumbling" | "sliding" | "session",
    options: Record<string, QueryValue> = {},
  ): Promise<JsonObject[]> {
    return this.client.request(
      "GET",
      `/continuity/streams/${segment(id)}/windows${query({
        tenant_id: tenantId,
        kind,
        ...options,
      })}`,
    );
  }

  retractFrames(id: string, body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", `/continuity/streams/${segment(id)}/retract`, body);
  }

  createInvariant(body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", "/continuity/invariants", body);
  }

  listInvariants(
    tenantId: string,
    sequenceId: string,
    sequenceVersion: number,
  ): Promise<JsonObject[]> {
    return this.client.request(
      "GET",
      `/continuity/invariants${query({
        tenant_id: tenantId,
        sequence_id: sequenceId,
        sequence_version: sequenceVersion,
      })}`,
    );
  }

  evaluateInvariants(id: string, body: JsonObject): Promise<JsonObject[]> {
    return this.client.request(
      "POST",
      `/continuity/executions/${segment(id)}/invariants/evaluate`,
      body,
    );
  }

  listInvariantResults(id: string, tenantId: string): Promise<JsonObject[]> {
    return this.client.request(
      "GET",
      `/continuity/executions/${segment(id)}/invariants/results${query({ tenant_id: tenantId })}`,
    );
  }

  appendEvaluation(id: string, body: JsonObject): Promise<JsonObject> {
    return this.client.request(
      "POST",
      `/continuity/executions/${segment(id)}/evaluations`,
      body,
    );
  }

  listEvaluations(id: string, tenantId: string): Promise<JsonObject[]> {
    return this.client.request(
      "GET",
      `/continuity/executions/${segment(id)}/evaluations${query({ tenant_id: tenantId })}`,
    );
  }

  evaluateGate(body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", "/continuity/evaluations/gate", body);
  }

  evaluateStoredGate(body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", "/continuity/evaluations/stored-gate", body);
  }

  reserveBudget(id: string, body: JsonObject): Promise<JsonObject> {
    return this.client.request(
      "POST",
      `/continuity/executions/${segment(id)}/budget-reservations`,
      body,
    );
  }

  listBudgetReservations(id: string, tenantId: string): Promise<JsonObject[]> {
    return this.client.request(
      "GET",
      `/continuity/executions/${segment(id)}/budget-reservations${query({ tenant_id: tenantId })}`,
    );
  }

  reconcileBudget(id: string, reservationId: string, body: JsonObject): Promise<JsonObject> {
    return this.client.request(
      "POST",
      `/continuity/executions/${segment(id)}/budget-reservations/${segment(reservationId)}/reconcile`,
      body,
    );
  }

  releaseBudget(id: string, reservationId: string, body: JsonObject): Promise<JsonObject> {
    return this.client.request(
      "POST",
      `/continuity/executions/${segment(id)}/budget-reservations/${segment(reservationId)}/release`,
      body,
    );
  }

  createAttentionTask(body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", "/continuity/attention", body);
  }

  assignAttentionTask(id: string, body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", `/continuity/attention/${segment(id)}/assign`, body);
  }

  decideAttentionTask(id: string, body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", `/continuity/attention/${segment(id)}/decide`, body);
  }

  listCheckpoints(id: string, tenantId: string, limit?: number): Promise<JsonObject[]> {
    return this.client.request(
      "GET",
      `/continuity/executions/${segment(id)}/checkpoints${query({ tenant_id: tenantId, limit })}`,
    );
  }

  getCheckpoint(id: string, checkpointId: string, tenantId: string): Promise<JsonObject> {
    return this.client.request(
      "GET",
      `/continuity/executions/${segment(id)}/checkpoints/${segment(checkpointId)}${query({ tenant_id: tenantId })}`,
    );
  }

  runWhatIf(id: string, body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", `/continuity/executions/${segment(id)}/what-if`, body);
  }

  listWhatIfRuns(id: string, tenantId: string): Promise<JsonObject[]> {
    return this.client.request(
      "GET",
      `/continuity/executions/${segment(id)}/what-if${query({ tenant_id: tenantId })}`,
    );
  }

  extractTestFixture(id: string, body: JsonObject): Promise<JsonObject> {
    return this.client.request(
      "POST",
      `/continuity/executions/${segment(id)}/test-fixture`,
      body,
    );
  }

  planMigration(body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", "/continuity/migrations/plan", body);
  }

  getMigration(id: string, tenantId: string): Promise<JsonObject> {
    return this.client.request(
      "GET",
      `/continuity/migrations/${segment(id)}${query({ tenant_id: tenantId })}`,
    );
  }

  applyMigration(id: string, body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", `/continuity/migrations/${segment(id)}/apply`, body);
  }

  rollbackMigration(id: string, body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", `/continuity/migrations/${segment(id)}/rollback`, body);
  }

  previewCompensation(id: string, body: JsonObject): Promise<JsonObject> {
    return this.client.request(
      "POST",
      `/continuity/executions/${segment(id)}/compensations/preview`,
      body,
    );
  }

  createCompensation(id: string, body: JsonObject): Promise<JsonObject> {
    return this.client.request(
      "POST",
      `/continuity/executions/${segment(id)}/compensations`,
      body,
    );
  }

  getCompensation(id: string, tenantId: string): Promise<JsonObject> {
    return this.client.request(
      "GET",
      `/continuity/compensations/${segment(id)}${query({ tenant_id: tenantId })}`,
    );
  }

  claimCompensation(id: string, body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", `/continuity/compensations/${segment(id)}/claim`, body);
  }

  completeCompensationStep(
    id: string,
    effectId: string,
    body: JsonObject,
  ): Promise<JsonObject> {
    return this.compensationStep(id, effectId, "complete", body);
  }

  failCompensationStep(id: string, effectId: string, body: JsonObject): Promise<JsonObject> {
    return this.compensationStep(id, effectId, "fail", body);
  }

  verifyCompensationStep(id: string, effectId: string, body: JsonObject): Promise<JsonObject> {
    return this.compensationStep(id, effectId, "verify", body);
  }

  generateScenarios(body: JsonObject): Promise<JsonObject[]> {
    return this.client.request("POST", "/continuity/scenarios/generate", body);
  }

  reproduceIncident(body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", "/continuity/scenarios/reproduce", body);
  }

  runFaultLab(body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", "/continuity/fault-lab/run", body);
  }

  chooseProvider(body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", "/continuity/providers/choose", body);
  }

  recommendOptimizations(body: JsonObject): Promise<JsonObject[]> {
    return this.client.request("POST", "/continuity/optimizations/recommend", body);
  }

  acceptOptimization(id: string, body: JsonObject): Promise<JsonObject> {
    return this.client.request(
      "POST",
      `/continuity/optimizations/${segment(id)}/accept`,
      body,
    );
  }

  evaluateResidency(body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", "/continuity/residency/evaluate", body);
  }

  minimizeDisclosure(body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", "/continuity/disclosure/minimize", body);
  }

  signFederationEnvelope(body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", "/continuity/federation/sign", body);
  }

  verifyFederationEnvelope(body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", "/continuity/federation/verify", body);
  }

  claimDeviceDelegation(body: JsonObject): Promise<JsonObject> {
    return this.client.request("POST", "/continuity/delegations/claim", body);
  }

  private compensationStep(
    id: string,
    effectId: string,
    action: "complete" | "fail" | "verify",
    body: JsonObject,
  ): Promise<JsonObject> {
    return this.client.request(
      "POST",
      `/continuity/compensations/${segment(id)}/steps/${segment(effectId)}/${action}`,
      body,
    );
  }
}
