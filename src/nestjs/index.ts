import type { DynamicModule } from "@nestjs/common";
import { Orch8Client } from "../client.js";
import type { Orch8ClientConfig, WorkerTask } from "../types.js";
import { Orch8Worker, type HandlerFn, type WorkerConfig } from "../worker.js";
import { createPushHandler, type PushHandlerOptions, type PushRequest, type PushResponse } from "../push/core.js";

/** Injection token for the shared {@link Orch8Client} (the class itself also works). */
export const ORCH8_CLIENT = Symbol.for("orch8.client");
/** Injection token for the options passed to {@link Orch8Module.forRoot}. */
export const ORCH8_MODULE_OPTIONS = Symbol.for("orch8.module-options");
/** Reflect-metadata key set by {@link Orch8Handler}, for use with Nest's `Reflector`. */
export const ORCH8_HANDLER_METADATA = "orch8:handler";

const handlerNames = new WeakMap<object, string>();

type LegacyMethodDecorator = (target: object, key: string | symbol, descriptor: PropertyDescriptor) => void;

/**
 * Mark a provider or controller method as the Orch8 worker handler `name`.
 * The method receives the {@link WorkerTask} and returns the step output.
 * Works with both `experimentalDecorators` (Nest's default) and standard
 * decorators.
 *
 * ```ts
 * @Injectable()
 * export class EmailHandlers {
 *   @Orch8Handler("send-email")
 *   async send(task: WorkerTask) { ... }
 * }
 * ```
 */
export function Orch8Handler(name: string): LegacyMethodDecorator & ((value: unknown, context: { kind: string }) => void) {
  if (!name) throw new TypeError("Orch8Handler requires a handler name");
  return ((targetOrValue: unknown, keyOrContext: unknown, descriptor?: PropertyDescriptor) => {
    const fn = descriptor ? descriptor.value : targetOrValue;
    if (typeof fn !== "function") throw new TypeError("@Orch8Handler can only decorate methods");
    handlerNames.set(fn, name);
    const reflect = Reflect as unknown as { defineMetadata?: (k: string, v: unknown, t: object) => void };
    reflect.defineMetadata?.(ORCH8_HANDLER_METADATA, name, fn);
    void keyOrContext;
  }) as LegacyMethodDecorator & ((value: unknown, context: { kind: string }) => void);
}

/** Handler name set by {@link Orch8Handler} on a method, if any. */
export function getOrch8HandlerName(method: unknown): string | undefined {
  return typeof method === "function" ? handlerNames.get(method) : undefined;
}

/** Collect `@Orch8Handler` methods from object instances, bound to their instance. */
export function discoverHandlers(instances: Iterable<unknown>): Record<string, HandlerFn> {
  const found: Record<string, HandlerFn> = {};
  const seen = new Set<unknown>();
  for (const instance of instances) {
    if (!instance || typeof instance !== "object" || seen.has(instance)) continue;
    seen.add(instance);
    for (let proto = Object.getPrototypeOf(instance); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
      for (const key of Object.getOwnPropertyNames(proto)) {
        if (key === "constructor") continue;
        const desc = Object.getOwnPropertyDescriptor(proto, key);
        const name = getOrch8HandlerName(desc?.value);
        if (!name) continue;
        if (found[name]) throw new Error(`duplicate @Orch8Handler("${name}")`);
        const method = desc!.value as (task: WorkerTask) => Promise<unknown>;
        found[name] = (task) => Promise.resolve(method.call(instance, task));
      }
    }
  }
  return found;
}

export interface Orch8ModuleOptions {
  /** A client instance, or config to construct one. */
  client: Orch8Client | Orch8ClientConfig;
  /**
   * Start a polling {@link Orch8Worker} on application bootstrap with every
   * discovered `@Orch8Handler`, and stop it on shutdown.
   */
  worker?: Omit<WorkerConfig, "client" | "handlers" | "engineUrl">;
  /** Extra handlers merged with discovered ones (explicit entries win). */
  handlers?: Record<string, HandlerFn>;
  /** Register the module globally. Default: true. */
  isGlobal?: boolean;
}

interface DiscoveryLike {
  getProviders(): Array<{ instance?: unknown }>;
  getControllers(): Array<{ instance?: unknown }>;
}

/**
 * Holds the discovered handler map. Inject it to build push receivers or to
 * inspect handlers; it also owns the optional worker's lifecycle.
 */
export class Orch8HandlerRegistry {
  private discovered: Record<string, HandlerFn> | undefined;
  private worker: Orch8Worker | undefined;

  constructor(
    private readonly discovery: DiscoveryLike | undefined,
    readonly client: Orch8Client,
    private readonly options: Pick<Orch8ModuleOptions, "worker" | "handlers">,
  ) {}

  /** Discovered `@Orch8Handler` methods merged with explicit handlers. */
  get handlers(): Record<string, HandlerFn> {
    if (!this.discovered) {
      const instances = this.discovery
        ? [...this.discovery.getProviders(), ...this.discovery.getControllers()].map((w) => w.instance)
        : [];
      this.discovered = discoverHandlers(instances.filter((i) => i !== this));
    }
    return { ...this.discovered, ...(this.options.handlers ?? {}) };
  }

  /** Build a push receiver over the registered handlers (wire it into a controller). */
  createPushHandler(
    options: Omit<PushHandlerOptions, "client" | "handlers">,
  ): (req: PushRequest) => Promise<PushResponse> {
    return createPushHandler({ ...options, client: this.client, handlers: this.handlers });
  }

  /** The running worker, when `worker` options were supplied. */
  get runningWorker(): Orch8Worker | undefined {
    return this.worker;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.options.worker || this.worker) return;
    this.worker = new Orch8Worker({ ...this.options.worker, client: this.client, handlers: this.handlers });
    await this.worker.start();
  }

  async onApplicationShutdown(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    await worker?.stop();
  }
}


/**
 * NestJS integration. `@nestjs/core` and `@nestjs/common` are optional peer
 * dependencies, loaded only when `forRoot` is called.
 *
 * ```ts
 * @Module({ imports: [Orch8Module.forRoot({ client: { baseUrl }, worker: { workerId: "api-1" } })] })
 * export class AppModule {}
 * ```
 */
export class Orch8Module {
  static forRoot(options: Orch8ModuleOptions): DynamicModule {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const core = require("@nestjs/core") as typeof import("@nestjs/core");
    const client = options.client instanceof Orch8Client ? options.client : new Orch8Client(options.client);
    return {
      module: Orch8Module,
      global: options.isGlobal ?? true,
      imports: [core.DiscoveryModule],
      providers: [
        { provide: ORCH8_MODULE_OPTIONS, useValue: options },
        { provide: ORCH8_CLIENT, useValue: client },
        { provide: Orch8Client, useValue: client },
        {
          provide: Orch8HandlerRegistry,
          useFactory: (discovery: DiscoveryLike) => new Orch8HandlerRegistry(discovery, client, options),
          inject: [core.DiscoveryService],
        },
      ],
      exports: [ORCH8_CLIENT, Orch8Client, Orch8HandlerRegistry, ORCH8_MODULE_OPTIONS],
    };
  }
}
