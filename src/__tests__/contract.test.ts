import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ORCH8_API_VERSION, ORCH8_ROUTES } from "../generated/routes.js";

describe("generated SDK contract", () => {
  it("contains the engine operations and shared transport fixture", () => {
    const fixture = JSON.parse(
      readFileSync(resolve(process.cwd(), "testdata/transport.json"), "utf8"),
    );
    expect(ORCH8_API_VERSION).toBe("1.0.0");
    expect(ORCH8_ROUTES.length).toBeGreaterThan(100);
    expect(ORCH8_ROUTES.some((route) => route.path === "/instances/{id}/stream")).toBe(true);
    expect(fixture.defaults.max_attempts).toBe(3);
    expect(fixture.safe_methods).toEqual(["GET", "HEAD"]);
  });
});
