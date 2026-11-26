import assert from "node:assert/strict";
import { test } from "node:test";
import { RemoteProjectDataService } from "../dist/src/workspace/project-data-remote.js";
import { createProjectDevelopmentService } from "../dist/src/dashboard/project-development-service.js";

/**
 * A read stays a read past this host: the shared gateway asks the authority
 * for data with the read-only marker, so the authority does not replay its own
 * deliveries for it, and a read-only read never binds this host's project.
 */

const json = (body) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

test("gateway reads carry the read-only marker; writes do not", async () => {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    seen.push({ path: pathname, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    if (pathname === "/api/session") return json({ session: { token: "session-token" } });
    if (pathname === "/api/project-data") return json({ engine: "sqlite", schemaVersion: 16 });
    return json({ developments: [], merges: [], deliveries: [], development: {}, delivery: {} });
  };
  const remote = await RemoteProjectDataService.open({
    url: "http://127.0.0.1:9",
    token: "token",
    backendId: "backend_reader",
    fetchImpl
  });
  seen.length = 0;
  await remote.queryDevelopments("project_a");
  await remote.getDevelopment("project_a", "development_a");
  await remote.findDevelopmentByRequirement("project_a", "requirement_a");
  await remote.queryMerges("project_a");
  await remote.queryDeliveries("project_a", "development_a");
  await remote.getDelivery("project_a", "delivery_a");
  assert.equal(seen.length, 6);
  for (const request of seen) assert.equal(request.headers["x-formicand-read-only"], "1", request.path);

  seen.length = 0;
  await remote.syncDelivery("project_a", { mergeId: "merge_a" });
  assert.equal(seen[0].headers["x-formicand-read-only"], undefined);
});

test("a read-only phase read finds the local project without binding it", async () => {
  const ensured = [];
  const gateway = {
    ensureProject: async (input) => {
      ensured.push(input.projectId);
      return input;
    },
    queryDevelopments: async () => [],
    queryReviews: async () => [],
    queryMerges: async () => [],
    queryDeliveries: async () => [],
    mergeConfig: async () => undefined
  };
  const project = {
    projectId: "project_local",
    projectName: "本机项目",
    projectDirectory: "/tmp/project-local"
  };
  const service = createProjectDevelopmentService({
    runtime: { service: async () => gateway },
    backendId: "backend_local",
    startedAt: "started-read-only-hop",
    developmentRoot: "/tmp/read-only-hop-developments",
    deliveryRoot: "/tmp/read-only-hop-deliveries",
    project: async (projectId) => (projectId === project.projectId ? project : undefined),
    taskProject: async () => undefined
  });
  assert.deepEqual(await service.deliveryPhases(project.projectId, { readOnly: true }), {});
  assert.deepEqual(ensured, [], "a read-only read binds nothing");
  await service.deliveryPhases(project.projectId);
  assert.deepEqual(ensured, [project.projectId], "a work read still binds the project");
});
