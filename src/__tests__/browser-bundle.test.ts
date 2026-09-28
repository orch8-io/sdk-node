import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LEASE_WORKER_SOURCE } from "../browser/lease-worker-source.js";

describe("browser entry", () => {
  it("ships a lease worker source regenerated from engine.ts", async () => {
    // @ts-expect-error -- plain ESM build script without type declarations
    const { renderLeaseWorkerModule } = await import("../../scripts/generate-lease-worker.mjs");
    const committed = readFileSync(resolve(process.cwd(), "src/browser/lease-worker-source.ts"), "utf8");
    expect(await renderLeaseWorkerModule(), "run `npm run generate:lease-worker`").toBe(committed);
  });

  it("keeps Node built-ins out of the lease worker source", () => {
    expect(LEASE_WORKER_SOURCE).not.toMatch(/node:|require\(/);
  });

  it("maps the ./browser export for browser, import and require conditions", () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    expect(pkg.exports["./browser"]).toMatchObject({
      types: "./dist/browser/index.d.ts",
      browser: "./dist/browser/index.js",
      import: "./dist/browser/index.js",
      require: "./dist/browser/index.js",
    });
  });
});
