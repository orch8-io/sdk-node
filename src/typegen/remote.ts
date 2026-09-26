import type { Orch8Client } from "../client.js";

export interface DataflowFinding {
  code: string;
  severity: "warning" | "error";
  consumer: string;
  reference: string;
  summary: string;
}

/** Response of `POST /sequences/dataflow` and `GET /sequences/{id}/dataflow`. */
export interface DataflowResponse {
  report: { findings: DataflowFinding[]; references_checked: number };
  generated: {
    generator_version: string;
    sequence_sha256: string;
    schema: unknown;
    typescript: string;
    python: string;
    swift?: string;
    kotlin?: string;
  };
}

/** Compile a draft sequence with the engine's typed-dataflow compiler. */
export function compileDraftDataflow(client: Orch8Client, sequence: unknown, strict = false): Promise<DataflowResponse> {
  return client.request<DataflowResponse>("POST", `/sequences/dataflow${strict ? "?strict=true" : ""}`, sequence);
}

/** Compile a stored sequence by id. */
export function compileStoredDataflow(client: Orch8Client, id: string): Promise<DataflowResponse> {
  return client.request<DataflowResponse>("GET", `/sequences/${encodeURIComponent(id)}/dataflow`);
}

export function hasDataflowErrors(response: DataflowResponse): boolean {
  return response.report.findings.some((f) => f.severity === "error");
}
