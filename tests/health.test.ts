import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { listen } from "./helpers.js";

describe("health", () => {
  it("answers ok", async () => {
    const server = await listen(createApp());
    try {
      const res = await fetch(`${server.base}/api/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      await server.close();
    }
  });
});
