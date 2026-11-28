import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const MAX_PORT_ATTEMPTS = 12;

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

/** Listen on an OS-assigned loopback port that HTTP clients can actually use. */
export async function listenOnLocalHttpPort(server: Server): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    try {
      // Fetch rejects some otherwise valid TCP ports (for example 6697) before connecting.
      // Any HTTP response proves reachability, including an authenticated host's 401.
      await fetch(`http://127.0.0.1:${port}/`, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(3_000)
      });
      return port;
    } catch (error) {
      await close(server);
      if (attempt >= MAX_PORT_ATTEMPTS)
        throw new Error("Could not allocate a fetch-accessible loopback HTTP port", { cause: error });
    }
  }
}

/** Find a port for a server whose URL must be configured before the server starts. */
export async function availableLocalHttpPort(): Promise<number> {
  const probe = createServer((_request, response) => response.writeHead(204).end());
  const port = await listenOnLocalHttpPort(probe);
  await close(probe);
  return port;
}
