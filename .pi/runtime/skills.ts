import type { Skill } from "@earendil-works/pi-coding-agent";
import type { SkillMetadata } from "../../dist/src/runtime/skill-registry.js";

/** A CoworkOS catalog entry in the shape Pi's prompt formatter expects. */
export function piSkill(skill: SkillMetadata): Skill {
  return {
    name: skill.name,
    description: skill.description,
    filePath: skill.path,
    baseDir: skill.directory,
    sourceInfo: { path: skill.path, source: "atria", scope: "project", origin: "top-level" },
    disableModelInvocation: false
  };
}
