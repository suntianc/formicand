import { channel } from "node:diagnostics_channel";

/** The desktop attempt ID joins this detached process's log with the host timeline. */
export function backendStartupTrace(attempt: string | undefined) {
  if (!attempt || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(attempt)) return;
  const started = performance.now();
  const channelName = channel("formicand.process-identity.query");
  let queries = 0;
  let totalQueryMs = 0;
  let readinessEnded = Number.POSITIVE_INFINITY;
  const write = (stage: string, details: Record<string, unknown> = {}) =>
    process.stdout.write(
      JSON.stringify({
        at: new Date().toISOString(),
        attempt,
        stage,
        elapsedMs: Math.round(performance.now() - started),
        queries,
        totalQueryMs: Math.round(totalQueryMs),
        ...details
      }) + "\n"
    );
  function onQuery(message: unknown) {
    const event = message as { started: number; durationMs: number; tool: string };
    queries++;
    totalQueryMs += event.durationMs;
    write("identity_query", {
      tool: event.tool,
      durationMs: Math.round(event.durationMs),
      queryStartedAt: new Date(performance.timeOrigin + event.started).toISOString(),
      phase: event.started < readinessEnded ? "application_ready" : "serving"
    });
  }
  channelName.subscribe(onQuery);
  write("backend_initializing");
  // A detached backend can serve for days. Keep per-query diagnostics within the initial launch.
  const timer = setTimeout(() => {
    channelName.unsubscribe(onQuery);
    write("observation_ended");
  }, 60_000);
  timer.unref();
  return {
    applicationReady() {
      readinessEnded = performance.now();
      write("application_ready");
    },
    listening() {
      write("port_listening");
    }
  };
}
