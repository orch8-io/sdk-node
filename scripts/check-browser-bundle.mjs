#!/usr/bin/env node
// Proves `@orch8.io/sdk/browser` is browser-safe:
//   1. bundles the entry (source and, when built, the published dist) with
//      esbuild for `platform: "browser"` with no Node polyfills — an import
//      of a Node built-in fails to resolve;
//   2. rejects any `node:` specifier or `require(` left in the output;
//   3. evaluates the pre-bundled lease-worker source, taken from a minified,
//      keep-names, ES2017 consumer-style bundle, in isolation (as a Web
//      Worker would), to prove it survives consumer-bundler transforms.
import { build } from "esbuild";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

const root = resolve(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");
const entries = [["src", resolve(root, "src/browser/index.ts")]];
const dist = resolve(root, "dist/browser/index.js");
if (existsSync(dist)) entries.push(["dist", dist]);

let failed = false;
const fail = (message) => {
  failed = true;
  console.error(`✗ ${message}`);
};

let bundleForSelfTest;
for (const [label, entry] of entries) {
  let result;
  try {
    result = await build({
      entryPoints: [entry],
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "es2017",
      minify: true,
      keepNames: true,
      write: false,
      logLevel: "silent",
    });
  } catch (err) {
    fail(`${label}: esbuild could not bundle for the browser:\n${err.message}`);
    continue;
  }
  const code = result.outputFiles[0].text;
  const nodeRefs = code.match(/["'`]node:[a-z_/]+["'`]/g);
  if (nodeRefs) fail(`${label}: bundle references Node built-ins: ${[...new Set(nodeRefs)].join(", ")}`);
  if (/\brequire\(/.test(code)) fail(`${label}: bundle contains require()`);
  console.log(`✓ ${label}: browser bundle ${(code.length / 1024).toFixed(1)} KiB, no node: imports`);
  if (label === "src") bundleForSelfTest = code;
}

if (bundleForSelfTest) {
  const mod = await import(`data:text/javascript;base64,${Buffer.from(bundleForSelfTest).toString("base64")}`);
  const source = mod.__leaseWorkerSource;
  const posted = [];
  const requests = [];
  let onMessage;
  const self = {
    postMessage: (message) => posted.push(message),
    addEventListener: (type, listener) => { if (type === "message") onMessage = listener; },
    fetch: (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return Promise.resolve(new Response(JSON.stringify({ tasks: [], lease_secs: 30 }), { status: 200 }));
    },
  };
  try {
    // A fresh realm with only worker-like globals, so the source cannot lean
    // on anything from this script or Node.
    runInNewContext(source, { self, setTimeout, clearTimeout, AbortController });
    onMessage({ data: { type: "start", config: {
      baseUrl: "https://engine.test", handlers: ["h"], maxConcurrent: 1, pollIntervalMs: 60_000,
      maxBackoffMs: 60_000, capabilityTtlSecs: 240, trust: "registered", refreshMarginMs: 60_000,
      defaultLeaseSecs: 30, requestTimeoutMs: 30_000,
    } } });
    onMessage({ data: { type: "token", token: "t", expiresAt: Date.now() + 600_000, runtimeId: "tab-1" } });
    await new Promise((r) => setTimeout(r, 50));
    onMessage({ data: { type: "stop", reason: "self-test" } });
    if (posted[0]?.type !== "ready") fail("lease worker did not post ready");
    const poll = requests[0];
    if (!poll || !poll.url.endsWith("/workers/tasks/poll") || poll.body.capabilities?.kind !== "browser") {
      fail("lease worker did not poll with browser capabilities");
    } else {
      console.log("✓ lease worker source runs in isolation (from a minified, keep-names, es2017 bundle)");
    }
  } catch (err) {
    fail(`serialized lease worker failed in isolation: ${err.stack ?? err}`);
  }
}

process.exit(failed ? 1 : 0);
