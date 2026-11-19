import {
  atriaInstallRoot,
  configuredProtectedPaths,
  type ProtectedPaths
} from "../../dist/src/tools/protected-paths.js";
import { protectedCallRefusal, type ProtectedCallRefusal } from "../../dist/src/tools/protected-call.js";
import { installRefusal, privateDataRefusal } from "../../dist/src/tools/private-data.js";
import { installedSkillRootNow } from "../../dist/src/runtime/skill-registry.js";

/**
 * The protected-path guard both process roles use at the tool-call boundary.
 *
 * Main and a delegated process run in different project directories but apply
 * the same rule: the CoworkOS runtime, version-control metadata and the
 * installed skills are never a write target.
 */
export function taskProtectedPaths(projectDirectory: string): ProtectedPaths {
  // Installed skills are readable (see private-data) but are the user's
  // configuration, so a file tool never writes them.
  return configuredProtectedPaths(projectDirectory, process.env, [
    atriaInstallRoot(),
    installedSkillRootNow()
  ]);
}

/**
 * The refusal for one tool call, or undefined when the call names neither
 * CoworkOS's own data nor its program, and writes nothing protected.
 */
export function blockedToolCall(
  toolName: string,
  input: unknown,
  guard: ProtectedPaths,
  projectDirectory: string
): ProtectedCallRefusal | undefined {
  return (
    privateDataRefusal(input) ??
    installRefusal(input, atriaInstallRoot(), projectDirectory) ??
    protectedCallRefusal(toolName, input, guard, projectDirectory)
  );
}
