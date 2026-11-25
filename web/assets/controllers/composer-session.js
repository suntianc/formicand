import { createComposerPrebind } from "./composer-prebind.js";

/** Conversation drafts stay separate from saved application documents. */
export function createComposerSession({
  input,
  getAttachments,
  setAttachments,
  storage,
  onError,
  onPersist,
  locks = globalThis.navigator?.locks
}) {
  const storagePrefix = "formicand.composer.v1:";
  let pendingStageBind;
  const journalKey = `${storagePrefix}migration-journal:active`;
  /**
   * Drafts belong to one backend. The prefix keeps a conversation started
   * against backend A out of backend B's composer, and a switch back restores
   * exactly the draft that backend had. Empty until the first backend is known,
   * when the first bind moves the preconnection keys into its namespace.
   */
  let namespace = "";
  const prefix = () => (namespace ? `${storagePrefix}${namespace}:` : storagePrefix);
  const memory = new Map();
  const pendingStorage = new Set();
  const retainedDrafts = new Map();
  const draftOwners = new Map();
  const draftIdentities = new Map();
  const pendingMigrations = new Map();
  const deferredSources = new Set();
  const migrationConflicts = new Map();
  const protectedDestinations = new Set();
  const retainedNulls = new Set();
  let journalPresent = false;
  let invalidJournal = false;
  let current;
  /** The draft the composer shows, which outlives `current` across a first bind. */
  let shownDraftIdentity;
  let editing;
  let editDraft;
  let token = 0;
  let nextDraftIdentity = 0;
  let warned = false;
  const projectDraft = (key) => typeof key === "string" && key.startsWith("new:");
  /**
   * The unbound new-conversation draft becomes the first selected project's
   * draft; an upload still in flight keeps the identity it started with.
   */
  const adoptDraftIdentity = (key, fromKey) => {
    const identity = draftIdentities.get(fromKey);
    if (identity === undefined) return;
    draftIdentities.delete(fromKey);
    draftIdentities.set(key, identity);
  };
  const hasContent = (draft) =>
    Boolean(draft && typeof draft === "object" && (draft.text || draft.attachments?.length || draft.editing));
  const readRecord = (storageKey) => {
    if (memory.has(storageKey)) return memory.get(storageKey);
    try {
      return JSON.parse(storage?.getItem(storageKey) || "null");
      // eslint-disable-next-line no-restricted-syntax -- a stored draft written by another build may not parse, and an unreadable record is treated as no draft
    } catch {
      return null;
    }
  };
  const keyFor = (key) => (!namespace && projectDraft(key) ? prebind.prefix + key : prefix() + key);
  const read = (key) => readRecord(keyFor(key));
  const hasRecord = (key) => {
    if (memory.has(key)) return memory.get(key) !== null || retainedNulls.has(key);
    return storage?.getItem(key) != null;
  };
  const writeRecord = (key, value) => {
    memory.set(key, value);
    try {
      if (!storage) throw new Error("storage unavailable");
      if (value === null && !retainedNulls.has(key)) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(value));
      onPersist?.();
      pendingStorage.delete(key);
      if (!pendingStorage.size) warned = false;
      return true;
      // eslint-disable-next-line no-restricted-syntax -- setItem throws when storage is full or blocked; the draft stays in memory, is queued for retry, and the user is warned once
    } catch {
      pendingStorage.add(key);
      if (!warned) onError?.("草稿暂时无法保存到本机，请保留当前窗口");
      warned = true;
      return false;
    }
  };
  const write = (key, value) => {
    let destination = keyFor(key);
    if (destination.startsWith(prebind.prefix)) {
      if (!prebind.claim()) {
        destination = keyFor(key);
        memory.set(destination, value);
        pendingStorage.add(destination);
        return false;
      }
      destination = keyFor(key);
    }
    const migration = pendingMigrations.get(destination);
    if (migration) migration.expectedDestination = value;
    if (value === null && (protectedDestinations.has(destination) || pendingMigrations.has(destination)))
      retainedNulls.add(destination);
    else retainedNulls.delete(destination);
    if (
      (pendingMigrations.has(destination) || protectedDestinations.has(destination)) &&
      (invalidJournal || pendingStorage.has(journalKey))
    ) {
      memory.set(destination, value);
      pendingStorage.add(destination);
      return false;
    }
    return writeRecord(destination, value);
  };
  const persistJournal = () => {
    if (invalidJournal) return false;
    const entries = [
      ...[...pendingMigrations].map(([destination, { sourceKey }]) => ({ sourceKey, destination })),
      ...[...migrationConflicts].map(([destination, { sourceKey }]) => ({
        sourceKey,
        destination,
        conflict: true
      }))
    ];
    if (!entries.length && !journalPresent && !pendingStorage.has(journalKey)) return true;
    const value = entries.length ? JSON.stringify(entries) : null;
    const saved = writeRecord(journalKey, value);
    journalPresent = Boolean(entries.length) || !saved;
    return saved;
  };
  const registerMigration = (destination, entry, needsWrite = true) => {
    pendingMigrations.set(destination, { ...entry, expectedDestination: entry.source });
    if (!persistJournal()) {
      if (needsWrite) {
        memory.set(destination, entry.source);
        pendingStorage.add(destination);
      }
      return;
    }
    if (needsWrite) writeRecord(destination, entry.source);
  };
  const finishMigrations = () => {
    if (pendingStorage.has(journalKey) || invalidJournal) return;
    let journalChanged = false;
    for (const [destination, { sourceKey, source, expectedDestination }] of pendingMigrations) {
      if (deferredSources.has(sourceKey)) continue;
      if (pendingStorage.has(destination) || pendingStorage.has(sourceKey)) continue;
      // Another window can update storage after this session cached the source.
      // Only remove a source that still matches in both memory and storage.
      try {
        if (!storage) throw new Error("storage unavailable");
        const stored = JSON.parse(storage.getItem(sourceKey) || "null");
        const storedDestination = JSON.parse(storage.getItem(destination) || "null");
        if (JSON.stringify(storedDestination) !== JSON.stringify(expectedDestination)) {
          migrationConflicts.set(destination, { sourceKey });
          protectedDestinations.add(destination);
          pendingMigrations.delete(destination);
          journalChanged = true;
          continue;
        }
        if (JSON.stringify(readRecord(sourceKey)) !== JSON.stringify(source)) {
          migrationConflicts.set(destination, { sourceKey });
          protectedDestinations.add(destination);
          pendingMigrations.delete(destination);
          journalChanged = true;
          continue;
        }
        if (JSON.stringify(stored) !== JSON.stringify(source)) {
          memory.set(sourceKey, stored);
          if (stored !== null) {
            migrationConflicts.set(destination, { sourceKey });
            protectedDestinations.add(destination);
          }
          pendingMigrations.delete(destination);
          journalChanged = true;
          continue;
        }
        storage.removeItem(sourceKey);
        onPersist?.();
        memory.set(sourceKey, null);
        retainedNulls.delete(sourceKey);
        pendingMigrations.delete(destination);
        journalChanged = true;
        // eslint-disable-next-line no-restricted-syntax -- removeItem throws on blocked storage; the migration stays registered in the journal and the next write retries it
      } catch {
        if (!warned) onError?.("草稿暂时无法保存到本机，请保留当前窗口");
        warned = true;
      }
    }
    for (const [destination, { sourceKey }] of migrationConflicts) {
      if (pendingStorage.has(sourceKey) || pendingStorage.has(destination)) continue;
      try {
        if (
          !storage ||
          storage.getItem(sourceKey) !== null ||
          (memory.has(sourceKey) && readRecord(sourceKey) !== null)
        )
          continue;
        migrationConflicts.delete(destination);
        protectedDestinations.delete(destination);
        if (storage.getItem(destination) === "null") {
          retainedNulls.delete(destination);
          writeRecord(destination, null);
        }
        journalChanged = true;
        // eslint-disable-next-line no-restricted-syntax -- the conflict cleanup also touches storage; a throwing read leaves the conflict registered for the next attempt
      } catch {
        if (!warned) onError?.("草稿暂时无法保存到本机，请保留当前窗口");
        warned = true;
      }
    }
    if (journalChanged) persistJournal();
  };
  const migratePrebind = (backendId) => {
    const marker = prebind.prefix + "active";
    if (pendingStorage.has(marker) || (prebind.entries(prebind.prefix).length && !prebind.claim())) {
      pendingStageBind ??= backendId;
      return;
    }
    pendingStageBind = undefined;
    const sources = prebind.entries(prebind.prefix);
    const writes = [];
    for (const sourceKey of sources) {
      const slot = sourceKey.slice(prebind.prefix.length);
      const staged = readRecord(sourceKey);
      const destination = `${storagePrefix}${backendId}:${slot}`;
      const existing = readRecord(destination);
      if (
        !hasRecord(destination) ||
        existing === null ||
        JSON.stringify(existing) === JSON.stringify(staged)
      ) {
        retainedNulls.delete(destination);
        pendingMigrations.set(destination, { sourceKey, source: staged, expectedDestination: staged });
        if (JSON.stringify(existing) !== JSON.stringify(staged)) writes.push([destination, staged]);
      } else {
        migrationConflicts.set(destination, { sourceKey });
        protectedDestinations.add(destination);
      }
    }
    // Journal the whole session before consuming any source. A crash between
    // projects must not leave the remaining entries with an unknown backend.
    if (sources.length && !persistJournal()) {
      for (const [destination, staged] of writes) {
        memory.set(destination, staged);
        pendingStorage.add(destination);
      }
      return;
    }
    for (const [destination, staged] of writes) writeRecord(destination, staged);
    finishMigrations();
    prebind.cleanup();
  };
  const restoreMigrations = () => {
    try {
      if (!storage) return;
      const raw = storage.getItem(journalKey);
      if (raw == null) return;
      const saved = JSON.parse(raw);
      if (typeof saved !== "string") throw new Error("invalid migration journal");
      const entries = JSON.parse(saved);
      if (
        !Array.isArray(entries) ||
        entries.some(
          (entry) =>
            !entry ||
            typeof entry.sourceKey !== "string" ||
            typeof entry.destination !== "string" ||
            !entry.sourceKey.startsWith(storagePrefix) ||
            !entry.destination.startsWith(storagePrefix) ||
            entry.sourceKey === entry.destination ||
            entry.sourceKey === journalKey ||
            entry.destination === journalKey ||
            entry.destination.endsWith(":active")
        )
      )
        throw new Error("invalid migration journal");
      journalPresent = true;
      let changed = false;
      const conservativeWrites = [];
      for (const { sourceKey, destination, conflict } of entries) {
        const source = JSON.parse(storage.getItem(sourceKey) || "null");
        const rawDestination = storage.getItem(destination);
        const target = JSON.parse(rawDestination || "null");
        if (source === null) {
          changed = true;
          continue;
        }
        if (prebind.unknownOccupancy && prebind.includes(sourceKey)) {
          // Without cross-context locks another window may still own the source.
          // Keep it and protect an explicit destination delete.
          migrationConflicts.set(destination, { sourceKey });
          protectedDestinations.add(destination);
          if (!conflict) changed = true;
          if (!conflict && rawDestination === null) {
            memory.set(destination, source);
            pendingStorage.add(destination);
            conservativeWrites.push(destination);
          }
          continue;
        }
        if (locks && prebind.includes(sourceKey) && !conflict) deferredSources.add(sourceKey);
        if (rawDestination === null && !conflict) {
          pendingMigrations.set(destination, { sourceKey, source, expectedDestination: source });
          memory.set(destination, source);
          pendingStorage.add(destination);
          continue;
        }
        if (conflict || JSON.stringify(source) !== JSON.stringify(target)) {
          migrationConflicts.set(destination, { sourceKey });
          protectedDestinations.add(destination);
          if (!conflict) changed = true;
        } else {
          pendingMigrations.set(destination, { sourceKey, source, expectedDestination: source });
        }
      }
      if (changed) persistJournal();
      if (!pendingStorage.has(journalKey)) {
        for (const destination of conservativeWrites) writeRecord(destination, memory.get(destination));
        for (const destination of pendingMigrations.keys()) {
          if (pendingStorage.has(destination)) writeRecord(destination, memory.get(destination));
        }
      }
      finishMigrations();
      // eslint-disable-next-line no-restricted-syntax -- the migration journal was written by an older launch and may not parse; the session keeps its in-memory drafts and reports the journal as invalid
    } catch {
      invalidJournal = true;
      onError?.("草稿迁移记录无法读取，请保留当前窗口并检查本机存储");
    }
  };
  const save = () => {
    if (current === undefined) return;
    const attachments = getAttachments();
    const draft = { text: input.value, attachments: [...attachments] };
    // Preserve the existing on-disk edit envelope while keeping the visible
    // composer independent. Its backup follows new typing in the composer.
    if (editing) editing = { ...editing, original: draft };
    write(
      current,
      input.value || attachments.length || editing ? (editing ? { ...editDraft, editing } : draft) : null
    );
    draftOwners.set(current, token);
    write("active", current);
  };
  const showDraft = (draft) => {
    shownDraftIdentity = draftIdentities.get(current);
    const candidate = draft?.editing;
    editing =
      candidate &&
      [candidate.messageId, candidate.versionId, candidate.runId].every(
        (value) => typeof value === "string"
      ) &&
      typeof candidate.editId === "string" &&
      typeof candidate.original?.text === "string" &&
      Array.isArray(candidate.original?.attachments)
        ? candidate
        : undefined;
    const validAttachments = (files) =>
      Array.isArray(files)
        ? files.filter(
            (file) =>
              typeof file?.name === "string" &&
              (typeof file?.text === "string" || /^upload-[a-f0-9-]{36}$/.test(file?.uploadId || ""))
          )
        : [];
    editDraft = editing
      ? {
          text: typeof draft.text === "string" ? draft.text : "",
          attachments: validAttachments(draft.attachments)
        }
      : undefined;
    const composerDraft = editing ? editing.original : draft;
    input.value = typeof composerDraft?.text === "string" ? composerDraft.text : "";
    setAttachments(validAttachments(composerDraft?.attachments));
  };
  const prebind = createComposerPrebind({
    storage,
    storagePrefix,
    locks,
    onError,
    projectDraft,
    hasContent,
    store: {
      readRecord,
      writeRecord,
      cachedKeys: () => [...memory.keys()],
      cachedValue: (key) => memory.get(key),
      isPending: (key) => pendingStorage.has(key),
      deferWrite: (key, value) => {
        memory.set(key, value);
        pendingStorage.add(key);
      },
      referencedSources: () =>
        [...pendingMigrations.values(), ...migrationConflicts.values()].map((item) => item.sourceKey)
    }
  });
  restoreMigrations();
  const deferredGroups = new Set(
    [...deferredSources]
      .map((key) => key.match(/^(formicand\.composer\.v1:__prebind__:[a-f0-9]{32}:)/)?.[1])
      .filter(Boolean)
  );
  const finishDeferredGroup = (group) => {
    for (const [destination, { sourceKey }] of pendingMigrations) {
      if (!sourceKey.startsWith(group)) continue;
      deferredSources.delete(sourceKey);
      if (pendingStorage.has(destination)) writeRecord(destination, memory.get(destination));
    }
    finishMigrations();
  };
  const ready = prebind.start(deferredGroups, finishDeferredGroup);
  input.addEventListener("input", save);
  return {
    ready,
    dispose() {
      return prebind.dispose();
    },
    async listRecoverableDrafts() {
      await ready;
      const referenced = new Set([...pendingMigrations.values()].map(({ sourceKey }) => sourceKey));
      const drafts = [];
      for (const [group] of prebind.groups(true) || []) {
        if (group === prebind.prefix && !namespace) continue;
        const release = group === prebind.prefix ? () => {} : await prebind.acquireLease(group);
        if (!release) continue;
        for (const key of prebind.entries(group)) {
          if (referenced.has(key)) continue;
          const draft = readRecord(key);
          const slot = key.slice(group.length);
          drafts.push({
            id: key,
            projectId: projectDraft(slot) ? decodeURIComponent(slot.slice(4)) : null,
            text: draft.text || "",
            attachments: draft.attachments || []
          });
        }
        await release();
      }
      return drafts;
    },
    async recoverDraft(id, { projectId } = {}) {
      const backend = namespace;
      const navigation = token;
      await ready;
      if (!backend || namespace !== backend || token !== navigation) return { ok: false, reason: "backend" };
      const candidates = await this.listRecoverableDrafts();
      const selected = candidates.find((candidate) => candidate.id === id);
      if (!selected) return { ok: false, reason: "unavailable" };
      const group = id.slice(0, id.lastIndexOf(":new") + 1);
      const release = group === prebind.prefix ? () => {} : await prebind.acquireLease(group);
      if (!release) return { ok: false, reason: "unavailable" };
      try {
        if (namespace !== backend || token !== navigation) return { ok: false, reason: "backend" };
        save();
        const slot = projectId ? `new:${encodeURIComponent(projectId)}` : "new";
        const destination = `${storagePrefix}${backend}:${slot}`;
        if (hasRecord(destination)) return { ok: false, reason: "conflict" };
        const source = JSON.parse(storage?.getItem(id) || "null");
        if (!hasContent(source)) return { ok: false, reason: "unavailable" };
        if (!prebind.unknownOccupancy) {
          registerMigration(destination, { sourceKey: id, source });
          finishMigrations();
        } else {
          // Without cross-context locks another window may still own the source.
          // Retain it and protect deletion of the recovered destination.
          migrationConflicts.set(destination, { sourceKey: id });
          protectedDestinations.add(destination);
          if (persistJournal()) writeRecord(destination, source);
          else {
            memory.set(destination, source);
            pendingStorage.add(destination);
          }
        }
        if (
          pendingStorage.has(destination) ||
          pendingStorage.has(journalKey) ||
          pendingMigrations.has(destination)
        )
          return { ok: false, reason: "save" };
        if (current === slot) showDraft(read(slot));
        return { ok: true };
      } finally {
        await release();
      }
    },
    get editing() {
      return editing;
    },
    beginEdit(target) {
      if (!current || editing) return false;
      const original = { text: input.value, attachments: [...getAttachments()] };
      editing = { ...target, editId: crypto.randomUUID(), original };
      editDraft = { text: target.body, attachments: [...target.attachments] };
      save();
      return true;
    },
    editSnapshot() {
      return editing ? { text: editDraft.text, attachments: [...editDraft.attachments] } : undefined;
    },
    updateEdit({ text = editDraft?.text, attachments = editDraft?.attachments }) {
      if (!editing) return false;
      editDraft = { text, attachments: [...attachments] };
      save();
      return true;
    },
    finishEdit(key = current, editId = editing?.editId, submittedDraft) {
      if (key === current) save();
      const saved = read(key);
      if (!editId || saved?.editing?.editId !== editId) return;
      if (
        submittedDraft &&
        (saved.text !== submittedDraft.text ||
          JSON.stringify(saved.attachments) !== JSON.stringify(submittedDraft.attachments))
      )
        return false;
      const original = saved.editing.original;
      write(key, original.text || original.attachments.length ? original : null);
      if (key === current) {
        editing = undefined;
        editDraft = undefined;
      }
      return true;
    },
    get currentKey() {
      return current;
    },
    get currentToken() {
      return token;
    },
    /** The identity of the draft on screen; uploads compare it across activations. */
    get shownDraftIdentity() {
      return shownDraftIdentity;
    },
    snapshot() {
      const draft = { text: input.value, attachments: [...getAttachments()] };
      retainedDrafts.set(token, draft);
      return draft;
    },
    release(sourceToken) {
      retainedDrafts.delete(sourceToken);
    },
    get activeTask() {
      const key = read("active");
      return typeof key === "string" && key !== "new" && !projectDraft(key) ? key : null;
    },
    get activeProject() {
      const key = read("active");
      return projectDraft(key) ? decodeURIComponent(key.slice(4)) : null;
    },
    get hasNewDraft() {
      const key = read("active");
      return projectDraft(key) || (key === "new" && Boolean(read("new")));
    },
    save,
    /** Persist the visible draft and leave it to its backend without showing it here. */
    detach() {
      save();
      current = undefined;
      shownDraftIdentity = undefined;
      editing = undefined;
      editDraft = undefined;
      token += 1;
      input.value = "";
      setAttachments([]);
    },
    prepareClose() {
      save();
      // Retry every failed conversation, including drafts that are no longer
      // selected. A disk mirror of stale localStorage cannot protect memory.
      if (pendingStorage.has(journalKey)) writeRecord(journalKey, memory.get(journalKey));
      for (const key of [...pendingStorage]) {
        if (prebind.requiresLease(key)) continue;
        if (
          (invalidJournal || pendingStorage.has(journalKey)) &&
          (pendingMigrations.has(key) || protectedDestinations.has(key))
        )
          continue;
        if (
          key.startsWith(prebind.prefix) &&
          key !== prebind.prefix + "active" &&
          pendingStorage.has(prebind.prefix + "active")
        )
          continue;
        writeRecord(key, memory.get(key));
      }
      finishMigrations();
      if (namespace && pendingStageBind) {
        const target = pendingStageBind;
        const wasEmpty =
          namespace === target &&
          current !== undefined &&
          !input.value &&
          !getAttachments().length &&
          !editing &&
          !read(current);
        migratePrebind(target);
        if (wasEmpty && read(current)) showDraft(read(current));
      }
      if (namespace && !pendingStageBind) prebind.cleanup();
      if (!namespace && !pendingStorage.size && !pendingMigrations.size && !invalidJournal) {
        prebind.prepareClose();
      }
      prebind.releaseClaim();
      return !invalidJournal && pendingStorage.size === 0 && pendingMigrations.size === 0;
    },
    /**
     * Bind drafts to one backend.
     *
     * The composer exists before the first connection, so its keys carry no
     * backend until then. The first bind moves those keys into the backend's
     * namespace once; later binds only change which namespace is read, and the
     * draft of the backend being left stays on disk exactly as it was.
     */
    setBackend(backendId) {
      const next = typeof backendId === "string" ? backendId : "";
      if (next === namespace) return;
      save();
      const previous = namespace;
      if (!previous && next) {
        const from = storagePrefix;
        const to = `${storagePrefix}${next}:`;
        try {
          const candidates = new Set(memory.keys());
          for (let index = 0; index < (storage?.length || 0); index += 1) {
            const key = storage.key(index);
            if (typeof key === "string" && key.startsWith(from)) candidates.add(key);
          }
          // A slot containing a colon already names a backend or an unbound
          // project draft; only the bare slots of this page move.
          const keys = [...candidates].filter(
            (key) =>
              typeof key === "string" &&
              key.startsWith(from) &&
              !key.startsWith(to) &&
              !key.slice(from.length).includes(":")
          );
          for (const key of keys) {
            if (key === from + "active") continue;
            const value = readRecord(key);
            if (!hasContent(value)) continue;
            const destination = to + key.slice(from.length);
            const existing = readRecord(destination);
            // Keep the preconnection draft as a recovery copy when the backend
            // already has a different draft there; that draft stays visible.
            if (hasRecord(destination) && JSON.stringify(existing) !== JSON.stringify(value)) {
              migrationConflicts.set(destination, { sourceKey: key });
              protectedDestinations.add(destination);
              persistJournal();
              continue;
            }
            registerMigration(destination, { sourceKey: key, source: value }, !hasRecord(destination));
          }
          finishMigrations();
          const active = from + "active";
          if (keys.includes(active)) {
            const destination = to + "active";
            const value = readRecord(active);
            if (!hasRecord(destination) && typeof value === "string") writeRecord(destination, value);
            writeRecord(active, null);
          }
          migratePrebind(next);
          // eslint-disable-next-line no-restricted-syntax -- reading the previous backend's records can throw on blocked storage; its drafts stay under the old prefix instead of being dropped
        } catch {
          /* Keep the original records when their migration cannot be read. */
        }
      }
      namespace = next;
      // The visible composer must not keep the backend being left's text; the
      // caller activates a conversation to load this backend's own draft.
      input.value = "";
      for (const key of memory.keys()) if (!pendingStorage.has(key)) memory.delete(key);
      retainedDrafts.clear();
      draftOwners.clear();
      // The first bind carries the draft it was showing into the backend's
      // namespace, so its identity stays and an upload it owns keeps running.
      // A switch to another backend replaces it.
      if (previous) {
        draftIdentities.clear();
        shownDraftIdentity = undefined;
      }
      editing = undefined;
      editDraft = undefined;
      current = undefined;
      token += 1;
      setAttachments([]);
    },
    activate(taskId, { fresh = false, projectId } = {}) {
      const key = taskId || (projectId ? `new:${encodeURIComponent(projectId)}` : "new");
      if (key === current && !fresh) return;
      save();
      if (retainedDrafts.has(token))
        retainedDrafts.set(token, { text: input.value, attachments: [...getAttachments()] });
      // An existing installation can have one global new-conversation draft.
      // Give it to the first selected project without losing its attachments.
      if (
        !fresh &&
        projectDraft(key) &&
        (current === "new" || current === undefined) &&
        ![...pendingMigrations.values()].some(({ sourceKey }) => sourceKey === keyFor("new")) &&
        !hasRecord(keyFor(key))
      ) {
        const source = read("new");
        if (source) {
          registerMigration(keyFor(key), { sourceKey: keyFor("new"), source });
          finishMigrations();
        }
        adoptDraftIdentity(key, "new");
      }
      current = key;
      token += 1;
      if (fresh || !draftIdentities.has(key)) draftIdentities.set(key, ++nextDraftIdentity);
      if (fresh) write(key, null);
      const draft = fresh ? null : read(key);
      draftOwners.set(key, token);
      showDraft(draft);
      write("active", key);
    },
    transfer(
      taskId,
      sourceKey = current,
      sourceToken = token,
      sourceDraft = null,
      { background = false } = {}
    ) {
      if (background || sourceKey !== current || sourceToken !== token) {
        // Creation can finish after navigation. Move only that draft, keeping
        // the current conversation and its unsent input exactly where they are.
        // A catalog can expose the new Task before its creation response.
        // Preserve drafts saved there meanwhile, including an explicit null
        // from clearing the composer; only an untouched target inherits it.
        if (!background || (!memory.has(prefix() + taskId) && read(taskId) === null))
          write(
            taskId,
            (background && sourceDraft) || retainedDrafts.get(sourceToken) || sourceDraft || read(sourceKey)
          );
        if (!background && sourceKey !== current && draftOwners.get(sourceKey) === sourceToken) {
          write(sourceKey, null);
          draftOwners.delete(sourceKey);
        }
        retainedDrafts.delete(sourceToken);
        return;
      }
      save();
      write(current, null);
      // The submitted draft now belongs to the task. Returning to its empty
      // new-conversation slot starts an independent draft and send gate.
      adoptDraftIdentity(taskId, current);
      current = taskId;
      save();
      retainedDrafts.delete(sourceToken);
    }
  };
}
