// Entry bundled into src/browser/lease-worker-source.ts (see generate-lease-worker.mjs).
import { leaseEngine, leaseWorkerBootstrap } from "../src/browser/engine.js";

leaseWorkerBootstrap(self as unknown as Parameters<typeof leaseWorkerBootstrap>[0], leaseEngine);
