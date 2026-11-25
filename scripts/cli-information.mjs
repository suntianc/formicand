import { readFile } from "node:fs/promises";

// SDK 0.87.1 builtin value-consumption rules only. Validation/extension flags
// remain the SDK's responsibility; this scanner never imports the runtime.
const valueFlags = new Set([
  "--provider",
  "--model",
  "--api-key",
  "--system-prompt",
  "--append-system-prompt",
  "--name",
  "-n",
  "--session",
  "--session-id",
  "--fork",
  "--session-dir",
  "--models",
  "--tools",
  "-t",
  "--exclude-tools",
  "-xt",
  "--thinking",
  "--export",
  "--extension",
  "-e",
  "--skill",
  "--prompt-template",
  "--theme"
]);
const guardedValueFlags = new Set(["--mode", "--tui-mode", "--use-theme"]);

export function scanCliArguments(args) {
  const flags = new Map();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--") break;
    if (!flag.startsWith("-")) continue;
    const next = args[index + 1];
    const previous = flags.get(flag);
    flags.set(flag, { index, value: undefined });
    const consumes =
      (valueFlags.has(flag) && next !== undefined) ||
      (guardedValueFlags.has(flag) && next !== undefined && !next.startsWith("-")) ||
      (["--list-models", "--print", "-p"].includes(flag) &&
        next !== undefined &&
        !next.startsWith("@") &&
        (!next.startsWith("-") || (["--print", "-p"].includes(flag) && next.startsWith("---")))) ||
      (flag.startsWith("--") &&
        !flag.includes("=") &&
        !valueFlags.has(flag) &&
        !guardedValueFlags.has(flag) &&
        ![
          "--help",
          "--version",
          "--continue",
          "--resume",
          "--no-session",
          "--no-tools",
          "--no-builtin-tools",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
          "--verbose",
          "--approve",
          "--no-approve",
          "--offline"
        ].includes(flag) &&
        next !== undefined &&
        !next.startsWith("-") &&
        !next.startsWith("@"));
    if (consumes) {
      flags.get(flag).value = next;
      index++;
    }
    if (flag === "--mode") {
      const current = flags.get(flag);
      const valid = ["text", "json", "rpc"].includes(current.value);
      current.effectiveValue = valid ? current.value : previous?.effectiveValue;
      current.fatalValueError = Boolean(previous?.fatalValueError || !valid);
    }
  }
  return flags;
}

export function classifyCliInformation(args) {
  const flags = scanCliArguments(args);
  if (flags.has("--help") || flags.has("-h")) return "help";
  if (flags.has("--version") || flags.has("-v")) {
    if (args.length !== 1) throw new Error("版本查询不接受执行参数；请单独运行 formicand --version。");
    return "version";
  }
  return undefined;
}

export async function printFormicandVersion() {
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  console.log(`Formicand ${version}`);
}

export function isInteractiveCli(args, stdinIsTTY, stdoutIsTTY) {
  const flags = scanCliArguments(args);
  const modeFlag = flags.get("--mode");
  const mode = modeFlag?.effectiveValue;
  return Boolean(
    stdinIsTTY &&
    stdoutIsTTY &&
    !modeFlag?.fatalValueError &&
    mode !== "json" &&
    mode !== "rpc" &&
    !["--print", "-p", "--help", "-h", "--version", "-v", "--list-models", "--export"].some((flag) =>
      flags.has(flag)
    )
  );
}

export function printFormicandHelp() {
  console.log(`Formicand — local multi-agent harness

Usage:
  formicand init                 Configure a model (API Key input is hidden)
  formicand doctor               Check Node, dependencies and configuration
  formicand doctor --test-connection  Test streaming, tools and optional image input (uses model quota)
  formicand update [--check]     Update this source checkout from its Git upstream
  formicand [start] [options]    Start Main in the current project; Main can delegate Subagents
  formicand --continue          Restore the latest conversation and its Task in this project
  formicand --session ID|PATH   Restore a specific conversation
  formicand --resume            Choose a saved conversation; enter 0 to cancel
  formicand session export ID|PATH [--format json|html] [--output FILE] [--force]
                            Export locally, without model calls or uploads
  formicand task list|create|status|cancel|resume|complete ...
  formicand human list|reply|answer|cancel ...
  formicand main-supervisor ...   Inspect recovery; --spawn permits launching Main
  formicand worker ...           Process delegated work
  formicand main-worker ...      Internal wake worker
  formicand COMMAND --help        Show command options without changing user data
  formicand backend start|status|stop  Run the standalone backend independently of a client
  formicand data paths           Show persistent data paths
  formicand --version

Non-interactive setup:
  formicand init --base-url https://YOUR-HOST/v1 --model YOUR-MODEL --api-key-env FORMICAND_API_KEY
  Optional: --images --reasoning --thinking high --max-tokens 8192 --force

Config: FORMICAND_CONFIG, then project .formicand/config.json / config.json, then ~/.formicand/config.json.
Environment overrides config. FORMICAND_HOME relocates App, CLI and Web data together.
No configuration values or API keys are printed by doctor.
Source checkout: run npm run build:cli once before use; rebuild after changing source.`);
}
