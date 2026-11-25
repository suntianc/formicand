// Fallback for synchronous consumers without Web Locks. Browser contexts use
// Web Locks, whose ownership ends automatically when a renderer exits.
const localClaims = new WeakMap();

/** Ownership and discovery for drafts written before a backend is known. */
export function createComposerPrebind({
  storage,
  storagePrefix,
  locks: lockManager,
  onError,
  store: { readRecord, writeRecord, cachedKeys, cachedValue, isPending, deferWrite, referencedSources },
  projectDraft,
  hasContent
}) {
  // Keep preconnection edits from different launches separate.
  const randomId = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join(
      ""
    );
  const prebindRoot = `${storagePrefix}__prebind__:`;
  const prebindId = randomId();
  const readyMarker = `ready:${lockManager ? "lease:" : ""}${prebindId}`;
  /**
   * A session writes its marker before its drafts. Records without a marker, and
   * markers from writers that never held a lease, are not sessions this version
   * created, so they are not offered as recoverable drafts.
   */
  const currentMarker = (marker) =>
    typeof marker === "string" &&
    (lockManager
      ? /^(?:live|ready:lease):[a-f0-9]{32}$/.test(marker)
      : /^(?:live|ready):[a-f0-9]{32}$/.test(marker));
  let prebindPrefix = `${prebindRoot}${prebindId}:`;
  let adoptedMarker;
  const unknownOccupancy = !lockManager && typeof window !== "undefined";
  const claims = storage && !lockManager ? localClaims.get(storage) || new Map() : null;
  if (claims && !localClaims.has(storage)) localClaims.set(storage, claims);
  let releaseLease;
  let disposed = false;
  const lockName = (prefix) => `formicand-composer:${prefix}`;
  const acquireLease = (prefix) => {
    if (!lockManager) {
      if (claims?.has(prefix) && claims.get(prefix) !== prebindId) return Promise.resolve(null);
      claims?.set(prefix, prebindId);
      return Promise.resolve(() => {
        if (claims?.get(prefix) === prebindId) claims.delete(prefix);
      });
    }
    return new Promise((resolve) => {
      let release;
      const held = new Promise((done) => {
        release = done;
      });
      const request = Promise.resolve().then(() =>
        lockManager.request(lockName(prefix), { ifAvailable: true }, async (lock) => {
          if (!lock) return resolve(null);
          resolve(async () => {
            release();
            await request;
          });
          await held;
        })
      );
      // eslint-disable-next-line no-restricted-syntax -- a rejected Web Locks request leaves this session without the lease; resolve(null) is the documented "not acquired" result callers already handle
      request.catch(() => resolve(null));
    });
  };
  const prebindEntries = (prefix) => {
    const keys = new Set(cachedKeys());
    for (let index = 0; index < (storage?.length || 0); index += 1) keys.add(storage.key(index));
    return [...keys].filter((key) => {
      if (typeof key !== "string" || !key.startsWith(prefix)) return false;
      const slot = key.slice(prefix.length);
      return (slot === "new" || projectDraft(slot)) && hasContent(readRecord(key));
    });
  };
  const claimPrebind = () => {
    if (lockManager && !releaseLease) return false;
    const marker = prebindPrefix + "active";
    if (isPending(marker) && cachedValue(marker) === `live:${prebindId}`) return false;
    let owner;
    try {
      owner = JSON.parse(storage?.getItem(marker) || "null");
      // eslint-disable-next-line no-restricted-syntax -- the prebind marker is shared with other windows and may be corrupt JSON; null means no owner has claimed it
    } catch {
      owner = null;
    }
    const claimedByOther = claims?.has(prebindPrefix) && claims.get(prebindPrefix) !== prebindId;
    if (
      claimedByOther ||
      (owner && owner !== `live:${prebindId}` && owner !== readyMarker && owner !== adoptedMarker)
    ) {
      // A successor adopted this session after close preparation. Keep the
      // continuing session's cached work under a fresh identity.
      const oldPrefix = prebindPrefix;
      const cached = cachedKeys()
        .filter((key) => key.startsWith(oldPrefix))
        .map((key) => [key, cachedValue(key)])
        .filter(([, draft]) => hasContent(draft));
      prebindPrefix = `${prebindRoot}${randomId()}:`;
      adoptedMarker = undefined;
      if (claims) claims.set(prebindPrefix, prebindId);
      for (const [key, draft] of cached) {
        const target = prebindPrefix + key.slice(oldPrefix.length);
        deferWrite(target, draft);
      }
      if (!writeRecord(prebindPrefix + "active", `live:${prebindId}`)) return false;
      for (const [key, draft] of cached) writeRecord(prebindPrefix + key.slice(oldPrefix.length), draft);
      return true;
    }
    if (claims) claims.set(prebindPrefix, prebindId);
    // A successfully closed draft stays recoverable even if this process
    // exits after taking the transient lease and before binding a backend.
    if (typeof owner === "string" && owner.startsWith("ready:")) return true;
    return owner === `live:${prebindId}` || writeRecord(marker, `live:${prebindId}`);
  };
  const prebindGroups = (includeReferenced = false) => {
    if (!storage) return;
    const groups = new Map();
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      const match =
        typeof key === "string" && key.match(/^formicand\.composer\.v1:__prebind__:([a-f0-9]{32}):(.*)$/);
      if (!match) continue;
      const prefix = `${prebindRoot}${match[1]}:`;
      if (!groups.has(prefix)) groups.set(prefix, { marker: null, content: false });
      const group = groups.get(prefix);
      if (match[2] === "active") group.marker = readRecord(key);
      else if ((match[2] === "new" || projectDraft(match[2])) && hasContent(readRecord(key)))
        group.content = true;
    }
    const referenced = referencedSources();
    const candidates = [...groups].filter(
      ([prefix, group]) =>
        group.content &&
        currentMarker(group.marker) &&
        (includeReferenced || !referenced.some((key) => key.startsWith(prefix)))
    );
    return candidates;
  };
  const adoptPrebind = (chosen) => {
    prebindPrefix = chosen[0];
    adoptedMarker = chosen[1].marker;
    claims?.set(prebindPrefix, prebindId);
  };
  const choosePrebind = () => {
    const candidates = prebindGroups() || [];
    const ready = candidates.filter(
      ([, group]) => typeof group.marker === "string" && group.marker.startsWith("ready:")
    );
    // A session that never reached close still owns its staged drafts; the
    // drafts of a single closed session move into the next backend.
    return ready.length === 1 ? ready[0] : null;
  };
  const cleanupEmptyPrebind = () => {
    const marker = prebindPrefix + "active";
    if (isPending(marker) || prebindEntries(prebindPrefix).length) return;
    const owner = JSON.parse(storage?.getItem(marker) || "null");
    if (owner === `live:${prebindId}` || owner === readyMarker || owner === adoptedMarker)
      writeRecord(marker, null);
  };
  function start(deferredGroups, finishDeferredGroup) {
    const chosen = choosePrebind();
    let ready;
    if (lockManager) {
      ready = (async () => {
        for (const group of deferredGroups) {
          const acquired = await acquireLease(group);
          if (acquired) {
            finishDeferredGroup(group);
            await acquired();
          } else {
            // A live owner retains the source until its context exits. The
            // queued lock resumes journal cleanup once that ownership ends.
            void Promise.resolve()
              .then(() =>
                lockManager.request(lockName(group), {}, (lock) => {
                  if (lock && !disposed) finishDeferredGroup(group);
                })
              )
              // eslint-disable-next-line no-restricted-syntax -- this queued lock only resumes journal cleanup; a rejection leaves the source records in storage for the next launch
              .catch(() => {});
          }
        }
        releaseLease = await acquireLease(prebindPrefix);
        if (!releaseLease) {
          onError?.("草稿暂时无法保存到本机，请保留当前窗口");
          return;
        }
        if (!chosen) return;
        const acquired = await acquireLease(chosen[0]);
        if (!acquired) return;
        const fresh = choosePrebind();
        if (!fresh || fresh[0] !== chosen[0] || fresh[1].marker !== chosen[1].marker) {
          await acquired();
          return;
        }
        await releaseLease();
        releaseLease = acquired;
        adoptPrebind(chosen);
      })();
    } else {
      if (chosen && !unknownOccupancy && (!claims?.has(chosen[0]) || claims.get(chosen[0]) === prebindId))
        adoptPrebind(chosen);
      else claims?.set(prebindPrefix, prebindId);
      ready = Promise.resolve();
    }
    return ready;
  }
  return {
    start,
    get prefix() {
      return prebindPrefix;
    },
    get unknownOccupancy() {
      return unknownOccupancy;
    },
    includes(key) {
      return key.startsWith(prebindRoot);
    },
    requiresLease(key) {
      return lockManager && !releaseLease && key.startsWith(prebindPrefix);
    },
    acquireLease,
    entries: prebindEntries,
    groups: prebindGroups,
    claim: claimPrebind,
    cleanup: cleanupEmptyPrebind,
    prepareClose() {
      const marker = prebindPrefix + "active";
      if (prebindEntries(prebindPrefix).length) {
        if (claimPrebind()) writeRecord(prebindPrefix + "active", readyMarker);
      } else {
        const owner = JSON.parse(storage?.getItem(marker) || "null");
        if (owner === `live:${prebindId}` || owner === readyMarker) writeRecord(marker, null);
      }
    },
    releaseClaim() {
      if (!lockManager && claims?.get(prebindPrefix) === prebindId) claims.delete(prebindPrefix);
    },
    dispose() {
      disposed = true;
      const released = releaseLease?.();
      if (claims?.get(prebindPrefix) === prebindId) claims.delete(prebindPrefix);
      return released;
    }
  };
}
