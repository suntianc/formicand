import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const harnessRoot = fileURLToPath(new URL("..", import.meta.url));

/** Configure a synthetic model for desktop-bridge UI tests without calling a provider. */
export function startConfiguredDashboard(options = {}) {
  return startDashboard({
    ...options,
    config: {
      baseUrl: "http://127.0.0.1:1/v1",
      model: "browser-fixture",
      apiKey: "local-fixture",
      ...options.config
    }
  });
}

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  return port;
}

/** A fresh real Dashboard; model connections, when supplied, are local test fixtures. */
export async function startDashboard({
  modelEndpoint,
  webSearchEndpoint,
  model = "browser-fixture",
  supportsImages = false,
  workspace: existingWorkspace,
  mainGuardian = false,
  sessionTitles = false,
  config = {},
  env = {},
  port: requestedPort,
  blenderExecutable,
  defaultProject = true
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "formicand-dashboard-test-"));
  const workspaceRoot = existingWorkspace ?? join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(root, "config.json"), JSON.stringify(config));
  let port = requestedPort ?? (await freePort());
  const isolatedEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(?:FORMICAND_|PI_|FORMICAND_|EXA_)/.test(name))
  );
  const launchOptions = {
    cwd: harnessRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...isolatedEnv,
      FORMICAND_HOME: join(root, "home"),
      PI_CODING_AGENT_DIR: join(root, "pi"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      FORMICAND_WORKSPACE: workspaceRoot,
      FORMICAND_GLOBAL_INDEX: join(root, "global.json"),
      FORMICAND_CONFIG: join(root, "config.json"),
      FORMICAND_UI_PORT: String(port),
      // Recovery is guardian-driven: only a fixture that tests it may relaunch a parked Task.
      FORMICAND_DISABLE_MAIN_GUARDIAN: mainGuardian ? "0" : "1",
      // Naming a conversation is one more model request; only a fixture that tests it asks for it.
      FORMICAND_DISABLE_SESSION_TITLES: sessionTitles ? "0" : "1",
      ...(blenderExecutable ? { FORMICAND_BLENDER_EXECUTABLE: blenderExecutable } : {}),
      ...(webSearchEndpoint ? { FORMICAND_EXA_MCP_ENDPOINT: webSearchEndpoint } : {}),
      FORMICAND_API_BASE: modelEndpoint ?? "",
      FORMICAND_API_KEY: modelEndpoint ? "local-fixture" : "",
      FORMICAND_SUPPORTS_IMAGES: modelEndpoint ? (supportsImages ? "1" : "0") : undefined,
      ...(modelEndpoint
        ? {
            FORMICAND_MODEL: model,
            FORMICAND_REASONING_EFFORT: "off",
            FORMICAND_SUPPORTS_REASONING_EFFORT: "0"
          }
        : {}),
      ...env
    }
  };
  let output = "";
  const record = (chunk) => {
    output = `${output}${chunk}`.slice(-4_000);
  };
  const launch = () => {
    const dashboardProcess = spawn(process.execPath, ["dist/src/cli/dashboard.js"], launchOptions);
    dashboardProcess.stdout.on("data", record);
    dashboardProcess.stderr.on("data", record);
    return dashboardProcess;
  };
  let child = launch();
  let base = `http://127.0.0.1:${port}`;
  const stopChild = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timeout = new AbortController();
      try {
        await Promise.race([exited, delay(4_500, undefined, { signal: timeout.signal })]);
      } finally {
        timeout.abort();
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
    }
  };
  const ready = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Dashboard exited before listening: ${output}`);
      try {
        if ((await fetch(`${base}/api/tasks`, { signal: AbortSignal.timeout(500) })).ok) {
          return;
        }
      } catch {
        /* the listener is still starting */
      }
      await delay(50);
    }
    throw new Error(`Dashboard did not become ready: ${output}`);
  };
  let stopping;
  const stop = () =>
    (stopping ??= (async () => {
      await stopChild();
      // A resident Main and a delegated process outlive the backend that
      // started them. The fixture is what finally ends them, by the identity
      // recorded at launch.
      await endAgentProcesses(workspaceRoot);
      // A process settling as the tree is removed can write one last record;
      // retry the removal instead of failing the test that already passed.
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    })());
  try {
    await ready();
    let project;
    if (defaultProject) {
      const response = await fetch(`${base}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectName: "测试项目", projectDirectory: workspaceRoot })
      });
      if (!response.ok) throw new Error(`Default project creation failed: ${response.status}`);
      ({ project } = await response.json());
    }
    return {
      /** The isolated environment the backend was launched with. */
      env: launchOptions.env,
      get base() {
        return base;
      },
      get child() {
        return child;
      },
      root,
      workspaceRoot,
      project,
      projectId: project?.projectId,
      stop,
      async restart({ newPort = false } = {}) {
        await stopChild();
        if (newPort) {
          port = await freePort();
          base = `http://127.0.0.1:${port}`;
          launchOptions.env.FORMICAND_UI_PORT = String(port);
        }
        output = "";
        child = launch();
        await ready();
      }
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * End every agent process this fixture left running, by its recorded group.
 *
 * Both Main and each delegated work item run as their own process group, so a
 * test that ends mid-run leaves processes whose FORMICAND_HOME is under this run's
 * temporary root; the runner reports those as leaked backends.
 */
export async function endAgentProcesses(workspaceRoot) {
  for (const task of await readdir(workspaceRoot, { withFileTypes: true }).catch(() => [])) {
    if (!task.isDirectory()) continue;
    const agents = join(workspaceRoot, task.name, "runs");
    for (const runId of await readdir(agents).catch(() => [])) {
      const records = [join(agents, runId, "agents", "main", "process.json")];
      const subagents = await readdir(join(agents, runId, "agents", "subagents"), {
        withFileTypes: true
      }).catch(() => []);
      for (const entry of subagents)
        if (entry.isDirectory())
          records.push(join(agents, runId, "agents", "subagents", entry.name, "process.json"));
      for (const path of records) {
        const record = await readFile(path, "utf8")
          .then((value) => JSON.parse(value))
          .catch(() => undefined);
        if (!record?.pid || record.host !== hostname()) continue;
        if (!(await sameProcess(record.pid, record.startedAt))) continue;
        try {
          process.kill(-record.pid, "SIGKILL");
        } catch {
          /* the group already exited */
        }
      }
    }
  }
}

async function sameProcess(pid, startedAt) {
  try {
    const { stdout } = await promisify(execFile)("ps", ["-p", String(pid), "-o", "lstart="], {
      timeout: 5_000,
      env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" }
    });
    return stdout.trim() === startedAt;
  } catch {
    return false;
  }
}
