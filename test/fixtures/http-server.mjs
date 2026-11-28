import { once } from "node:events";
import { availableLocalHttpPort } from "../../dist/src/platform/local-http-port.js";

/** Bind the fixture without sending a probe into its application protocol. */
export async function listenOnFixtureHttpPort(server) {
  for (let attempt = 1; ; attempt++) {
    const port = await availableLocalHttpPort();
    server.listen(port, "127.0.0.1");
    try {
      await once(server, "listening");
      return port;
    } catch (error) {
      if (error.code !== "EADDRINUSE" || attempt >= 12) throw error;
    }
  }
}
