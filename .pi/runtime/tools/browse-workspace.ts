import { Type } from "typebox";

export const browseWorkspaceParameters = Type.Object({
  mode: Type.Optional(Type.Union([Type.Literal("tree"), Type.Literal("read"), Type.Literal("search")])),
  path: Type.Optional(
    Type.String({
      description: "Relative path inside the Task workspace; default is the workspace root."
    })
  ),
  query: Type.Optional(Type.String({ description: "Text to search for when mode=search." })),
  offset: Type.Optional(
    Type.Number({
      description: "Byte offset for mode=read; use nextOffset from a truncated result to continue."
    })
  ),
  depth: Type.Optional(Type.Number({ description: "Tree depth, default 2." })),
  maxEntries: Type.Optional(Type.Number({ description: "Maximum entries or matches, default 200." }))
});
