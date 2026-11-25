const { homedir } = require("node:os");
const { dirname, join, resolve } = require("node:path");

/** All hosts share a stable user home, independently of the installation. */
function formicandHome(env = process.env, home = homedir()) {
  return resolve(env.FORMICAND_HOME || join(home, ".formicand"));
}

/** @param {{workspaceRoot?: string}} config */
function formicandDataPaths(env = process.env, config = {}, cwd = process.cwd(), home = homedir()) {
  const root = formicandHome(env, home);
  const globalIndex = resolve(cwd, env.FORMICAND_GLOBAL_INDEX || join(root, "runtime", "workspaces.json"));
  return {
    home: root,
    workspaceRoot: resolve(cwd, env.FORMICAND_WORKSPACE || config.workspaceRoot || join(root, "workspace")),
    piAgentDir: resolve(cwd, env.PI_CODING_AGENT_DIR || join(root, "pi")),
    globalIndex,
    configPath: join(root, "config.json"),
    logs: join(root, "logs")
  };
}

module.exports = { formicandHome, formicandDataPaths };
