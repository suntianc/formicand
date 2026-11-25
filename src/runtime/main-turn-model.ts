import type { FormicandConfig } from "./config.js";
import { resolveModelRole, type ResolvedModelRole } from "./role-models.js";
import type { PiThinkingLevel } from "./runtime-settings.js";

/**
 * Marker the Dashboard sets on a Main launch whose connection it resolved from
 * this host's saved configuration.
 *
 * A connection pinned by the launch environment itself must stay pinned for the
 * process's life, so only a marked launch re-reads a connection at a turn
 * boundary. Both cases look identical in the child process otherwise: the
 * Dashboard copies the resolved values into `FORMICAND_API_*` either way.
 */
export const MAIN_MODEL_FROM_CONFIG = "FORMICAND_MAIN_MODEL_FROM_CONFIG";

/**
 * The model the person picked for this Run's message, on the connection the
 * launch resolved. A turn that re-reads the saved connection keeps it while
 * that connection is still the one in use: the connection's own default model
 * is not the person's choice.
 */
export const MAIN_TURN_MODEL = "FORMICAND_MAIN_TURN_MODEL";

/**
 * Model values a launch already fixed.
 *
 * A resident Main re-reads the host file for the next turn, so every value the
 * Dashboard copied into the environment at launch would otherwise outrank that
 * file: role resolution reads `FORMICAND_API_BASE`, `FORMICAND_MODEL` and the profile
 * keys straight from the environment.
 */
const LAUNCH_MODEL_ENV = [
  "FORMICAND_API_BASE",
  "FORMICAND_API_KEY",
  "FORMICAND_MODEL",
  "FORMICAND_CONNECTION_ID",
  "FORMICAND_MODEL_API",
  "FORMICAND_THINKING_FORMAT",
  "FORMICAND_REASONING_EFFORT",
  "FORMICAND_SUPPORTS_REASONING_EFFORT",
  "FORMICAND_SUPPORTS_PROMPT_CACHE_KEY",
  "FORMICAND_SUPPORTS_IMAGES",
  "FORMICAND_CONTEXT_WINDOW",
  "FORMICAND_MAIN_MAX_TOKENS",
  "FORMICAND_MAX_TOKENS"
] as const;

/**
 * The connection one resident turn should use, from the host file saved now.
 *
 * Returns `undefined` when this launch's connection is pinned rather than read
 * from the host file (environment, a one-off profile or an archived retry),
 * and when the saved configuration names no usable connection: the process
 * keeps the connection it was started with rather than failing a turn over a
 * file it cannot use. The explicit level is the one the message that opens the
 * turn chose; the connection's own level is the default for every other turn.
 */
export function resolveMainTurnModel(
  config: FormicandConfig,
  input: { thinkingLevel?: PiThinkingLevel; projectDirectory?: string } = {},
  env: NodeJS.ProcessEnv = process.env
): ResolvedModelRole | undefined {
  if (env[MAIN_MODEL_FROM_CONFIG] !== "1") return undefined;
  const launchFree: NodeJS.ProcessEnv = { ...env };
  for (const name of LAUNCH_MODEL_ENV) delete launchFree[name];
  const request = {
    role: "main" as const,
    ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
    ...(input.projectDirectory ? { projectDirectory: input.projectDirectory } : {})
  };
  let selection = resolveModelRole(config, request, launchFree);
  const chosen = env[MAIN_TURN_MODEL]?.trim();
  // A picked model names a model of the launch's connection; another
  // connection saved since then starts from its own default.
  if (chosen && selection.connectionId === env.FORMICAND_CONNECTION_ID)
    selection = resolveModelRole(config, { ...request, model: chosen }, launchFree);
  return selection.baseUrl && selection.apiKey ? selection : undefined;
}
