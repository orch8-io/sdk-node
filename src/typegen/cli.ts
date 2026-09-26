#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Orch8Client } from "../client.js";
import { completeSequence } from "../sequence-defaults.js";
import { generateSequenceTypes } from "./generate.js";
import { compileDraftDataflow, compileStoredDataflow, hasDataflowErrors, type DataflowResponse } from "./remote.js";

const USAGE = `Usage:
  orch8-typegen <sequence.json> [--out types.ts] [--prefix Name] [--check]
      Generate TypeScript types locally from input_schema / step output_schema.

  orch8-typegen --remote <sequence.json> [--strict] [--out types.ts] [--check]
  orch8-typegen --remote --id <sequence-uuid> [--out types.ts] [--check]
      Use the engine's typed-dataflow compiler (POST /sequences/dataflow or
      GET /sequences/{id}/dataflow) and write its TypeScript bindings. Exits 1
      when the dataflow report contains an error. Reads ORCH8_URL,
      ORCH8_API_KEY and ORCH8_TENANT_ID (or --url).

  --check   Do not write; exit 1 if --out differs from the generated output.
`;

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  fetch?: typeof fetch;
}

interface Args {
  file?: string;
  out?: string;
  prefix?: string;
  check: boolean;
  remote: boolean;
  strict: boolean;
  id?: string;
  url?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { check: false, remote: false, strict: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      return v;
    };
    if (a === "--out" || a === "-o") args.out = value();
    else if (a === "--prefix") args.prefix = value();
    else if (a === "--id") args.id = value();
    else if (a === "--url") args.url = value();
    else if (a === "--check") args.check = true;
    else if (a === "--remote") args.remote = true;
    else if (a === "--strict") args.strict = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else if (args.file === undefined) args.file = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return args;
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

/** CLI entry point; returns the process exit code. */
export async function runCli(argv: string[], io: CliIO): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.stderr(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    io.stdout(USAGE);
    return 0;
  }
  if (!args.file && !(args.remote && args.id)) {
    io.stderr(USAGE);
    return 2;
  }

  let output: string;
  let failed = false;
  try {
    const sequence = args.file
      ? (JSON.parse(readFileSync(resolve(io.cwd, args.file), "utf8")) as Record<string, unknown>)
      : undefined;
    if (!args.remote) {
      output = generateSequenceTypes(sequence!, { typePrefix: args.prefix });
    } else {
      const baseUrl = args.url ?? io.env.ORCH8_URL;
      if (!baseUrl) throw new Error("--remote needs ORCH8_URL or --url");
      const client = new Orch8Client({
        baseUrl,
        tenantId: io.env.ORCH8_TENANT_ID,
        headers: io.env.ORCH8_API_KEY ? { "x-api-key": io.env.ORCH8_API_KEY } : {},
        ...(io.fetch ? { fetch: io.fetch } : {}),
      });
      let response: DataflowResponse;
      if (args.id) {
        response = await compileStoredDataflow(client, args.id);
      } else {
        // Deterministic placeholder id so unchanged files hash identically.
        const draft = completeSequence(sequence!, {
          id: "00000000-0000-7000-8000-000000000000",
          tenantId: io.env.ORCH8_TENANT_ID,
        });
        response = await compileDraftDataflow(client, draft, args.strict);
      }
      for (const f of response.report.findings) {
        io.stderr(`${f.severity.toUpperCase()} ${f.code} ${f.consumer}${f.reference ? ` (${f.reference})` : ""}: ${f.summary}\n`);
      }
      failed = hasDataflowErrors(response);
      output = response.generated.typescript;
    }
  } catch (err) {
    io.stderr(`orch8-typegen: ${(err as Error).message}\n`);
    return 1;
  }

  if (args.check) {
    if (!args.out) {
      io.stderr("--check requires --out\n");
      return 2;
    }
    let current = "";
    try {
      current = readFileSync(resolve(io.cwd, args.out), "utf8");
    } catch {
      // missing file counts as out of date
    }
    if (current !== output) {
      io.stderr(`${args.out} is out of date; re-run orch8-typegen\n`);
      return 1;
    }
    return failed ? 1 : 0;
  }
  if (args.out) writeAtomic(resolve(io.cwd, args.out), output);
  else io.stdout(output);
  return failed ? 1 : 0;
}

if (require.main === module) {
  runCli(process.argv.slice(2), {
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    env: process.env,
    cwd: process.cwd(),
  }).then((code) => {
    process.exitCode = code;
  });
}
