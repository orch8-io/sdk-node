import { randomUUID } from "node:crypto";

/**
 * Fill the server-assigned fields a builder-produced sequence lacks, mirroring
 * `Orch8Client.createSequence`, so `workflow(...).build()` output can be sent
 * to endpoints that expect a full `SequenceDefinition`.
 */
export function completeSequence(
  input: object,
  defaults: { id?: string; tenantId?: string; createdAt?: string } = {},
): Record<string, unknown> {
  const sequence = input as Record<string, unknown>;
  return {
    ...sequence,
    id: sequence.id ?? defaults.id ?? randomUUID(),
    tenant_id: sequence.tenant_id ?? defaults.tenantId ?? "test",
    namespace: sequence.namespace ?? "default",
    version: sequence.version ?? 1,
    deprecated: sequence.deprecated ?? false,
    status: sequence.status ?? "production",
    created_at: sequence.created_at ?? defaults.createdAt ?? new Date(0).toISOString(),
  };
}
