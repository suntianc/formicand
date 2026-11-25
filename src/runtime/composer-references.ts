import { z } from "zod";

/**
 * What a person picked with `/` and `@` in the composer. The words stay in the
 * message as typed (`/name`, `@path`, `@server:uri`); the backend resolves
 * these and puts a manifest in front of the message, so Main is told plainly
 * what each one is.
 */
export const composerReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("skill"), name: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal("file"), path: z.string().min(1).max(1024) }).strict(),
  z.object({ kind: z.literal("agent"), name: z.string().min(1).max(64) }).strict(),
  z
    .object({
      kind: z.literal("mcp_resource"),
      server: z.string().min(1).max(64),
      uri: z.string().min(1).max(2048)
    })
    .strict()
]);
export const composerReferencesSchema = z.array(composerReferenceSchema).max(20);
export type ComposerReference = z.infer<typeof composerReferenceSchema>;

/** A reference after the backend checked it: skills carry their file. */
export type ResolvedReference =
  | { kind: "skill"; name: string; path: string }
  | { kind: "file"; path: string }
  | { kind: "agent"; name: string }
  | { kind: "mcp_resource"; server: string; uri: string };

const OPEN = "<formicand_references>\n";
const CLOSE_TAG = "\n</formicand_references>";
const CLOSE = `${CLOSE_TAG}\n\n`;

const NOTE =
  "The user attached these references to the message below with / and @ in the composer. " +
  "skill: load it with load_skill by name before anything else and follow it for this message. " +
  "file: a path relative to projectDirectory, referenced rather than uploaded; read it when you need it. " +
  "agent: the user wants this work handed to that Agent; delegate it with call_subagent agent=<name>. " +
  "mcp_resource: read it with read_mcp_resource using server and uri.";

/** The manifest put in front of a message; empty when nothing resolved. */
export function referencesBlock(
  projectDirectory: string | undefined,
  references: ResolvedReference[]
): string {
  if (!references.length) return "";
  return (
    OPEN +
    JSON.stringify({
      version: 1,
      note: NOTE,
      ...(projectDirectory ? { projectDirectory } : {}),
      // A skill is loaded by name; its file path would invite reading it directly.
      references: references.map((reference) =>
        reference.kind === "skill" ? { kind: "skill", name: reference.name } : reference
      )
    }) +
    CLOSE
  );
}

/** The message without a leading manifest, as the person typed it. */
export function stripReferencesBlock(text: string): string {
  if (!text.startsWith(OPEN)) return text;
  const end = text.indexOf(CLOSE, OPEN.length);
  if (end >= 0) return text.slice(end + CLOSE.length);
  const tagEnd = text.indexOf(CLOSE_TAG, OPEN.length);
  return tagEnd < 0 ? text : text.slice(tagEnd + CLOSE_TAG.length).replace(/^\n+/, "");
}
