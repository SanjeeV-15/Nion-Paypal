import type { AddressInfo } from "node:net";
import type { Express } from "express";

export interface TestServer {
  base: string;
  close: () => Promise<void>;
}

/**
 * Starts the app on loopback only, and waits until it is really listening.
 * A wildcard bind on a random port can be shadowed by an unrelated local
 * service on the same port, which made these tests fail about once in 300 runs.
 */
export function listen(app: Express): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1");
    server.once("error", reject);
    server.once("listening", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
