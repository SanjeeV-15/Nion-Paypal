import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("health", () => {
  it("answers ok", async () => {
    const server = createApp().listen(0);
    try {
      const { port } = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    } finally {
      server.close();
    }
  });
});
