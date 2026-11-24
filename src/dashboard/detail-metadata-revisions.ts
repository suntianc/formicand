import { createHash } from "node:crypto";

const digest = (text: string) => createHash("sha256").update(text).digest("base64url");

/** Store only field hashes. Eviction, reconnects and server restarts send a full metadata snapshot. */
export class DetailMetadataRevisions {
  private readonly revisions = new Map<string, { taskId: string; fields: Map<string, string> }>();

  diff(taskId: string, metadata: Record<string, unknown>, base?: string) {
    const entry = base ? this.revisions.get(base) : undefined;
    const previous = entry?.taskId === taskId ? entry.fields : undefined;
    const fields = new Map<string, string>();
    const changes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (value === undefined) continue;
      const hash = digest(JSON.stringify(value));
      fields.set(key, hash);
      if (previous?.get(key) !== hash) changes[key] = value;
    }
    const revision = digest(JSON.stringify([taskId, [...fields]]));
    this.revisions.delete(revision);
    this.revisions.set(revision, { taskId, fields });
    if (this.revisions.size > 128) this.revisions.delete(this.revisions.keys().next().value!);
    const removed = previous ? [...previous.keys()].filter((key) => !fields.has(key)) : [];
    return { ...changes, metadataPatch: { revision, base: previous ? base : undefined, removed } };
  }
}
