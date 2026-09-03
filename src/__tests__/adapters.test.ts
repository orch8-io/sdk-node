import { describe, expect, it } from "vitest";
import { durableAgentHandler } from "../adapters.js";

describe("durableAgentHandler", () => {
  it("pins LangGraph thread identity to the durable instance", async () => {
    const handler = durableAgentHandler({
      invoke: async (input: { text: string }, config?: unknown) => ({ input, config }),
    });
    await expect(handler({ params: { text: "hi" }, instance_id: "inst-1" })).resolves.toEqual({
      input: { text: "hi" },
      config: { configurable: { thread_id: "inst-1" } },
    });
  });
});
