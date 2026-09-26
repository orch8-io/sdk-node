import { completeSequence } from "../sequence-defaults.js";

export { completeSequence };

/** Shape of `@orch8/engine-native` (engine repo: packages/node-native). */
export interface EngineNativeBindings {
  validateSequenceJson(input: string): string;
  sequenceSchemaVersion(): number;
  runSequenceJson(sequenceJson: string, inputJson?: string, maxTicks?: number): Promise<string>;
}

export interface NativeRunResult<C = Record<string, unknown>> {
  /** Final instance state, e.g. `"completed"`, `"failed"`, `"waiting"`. */
  state: string;
  /** Full execution context after the last scheduler tick. */
  context: C & { data?: unknown };
  /** Persisted block outputs in storage order. */
  outputs: Array<{ block_id: string; output: unknown; [key: string]: unknown }>;
  /** Scheduler passes used. */
  ticks: number;
}

export interface NativeRunOptions {
  /** Scheduler tick budget (engine clamps to 1..100000). Default: 1000. */
  maxTicks?: number;
}

export const NATIVE_PACKAGE = "@orch8/engine-native";

/**
 * Time-skipping, zero-server test environment backed by the engine's Rust core
 * through its napi bindings. Delays and retry backoffs advance a virtual clock,
 * so a sequence with a 3-day delay finishes in milliseconds.
 *
 * Scope (from the engine's `run_sequence_once`): built-in handlers run in
 * dry-run mode and human approvals are auto-approved. Steps dispatched to
 * external workers are not executed here; a run that waits on one (or on a
 * signal) returns with `state: "waiting"`. Unit-test worker handlers with
 * {@link FakeOrch8Server} instead.
 */
export class NativeTestEnvironment {
  constructor(private readonly native: EngineNativeBindings) {}

  /** Sequence schema version understood by the loaded engine build. */
  get schemaVersion(): number {
    return this.native.sequenceSchemaVersion();
  }

  /**
   * Strictly decode and validate a sequence with the server's Rust types.
   * Returns the normalized definition; throws on unknown fields or errors.
   */
  validate<T = Record<string, unknown>>(sequence: object): T {
    return JSON.parse(this.native.validateSequenceJson(JSON.stringify(completeSequence(sequence)))) as T;
  }

  /** Run a sequence to completion (or `waiting`) on virtual time. */
  async run<C = Record<string, unknown>>(
    sequence: object,
    input: unknown = {},
    options: NativeRunOptions = {},
  ): Promise<NativeRunResult<C>> {
    const raw = await this.native.runSequenceJson(
      JSON.stringify(completeSequence(sequence)),
      JSON.stringify(input),
      options.maxTicks,
    );
    return JSON.parse(raw) as NativeRunResult<C>;
  }
}

/**
 * Load the native bindings (optional peer dependency `@orch8/engine-native`)
 * and return a {@link NativeTestEnvironment}. Pass `bindings` to inject a
 * build explicitly (e.g. a local `.node` file).
 */
export async function createNativeTestEnvironment(
  options: { bindings?: EngineNativeBindings } = {},
): Promise<NativeTestEnvironment> {
  if (options.bindings) return new NativeTestEnvironment(options.bindings);
  let loaded: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require(NATIVE_PACKAGE);
  } catch (cause) {
    throw new Error(
      `${NATIVE_PACKAGE} is not installed. Install it to use the native test environment ` +
        "(it is an optional peer dependency), or use FakeOrch8Server for worker tests.",
      { cause },
    );
  }
  return new NativeTestEnvironment(loaded as EngineNativeBindings);
}

/** True when the optional native engine bindings can be loaded. */
export function isNativeEngineAvailable(): boolean {
  try {
    require.resolve(NATIVE_PACKAGE);
    return true;
  } catch {
    return false;
  }
}
