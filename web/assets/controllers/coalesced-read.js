/** One read per key, with one follow-up for mutations arriving mid-read. */
export function createCoalescedRead(read) {
  const pending = new Map();
  return function request(key, { poll = false, afterMutation = false } = {}) {
    const current = pending.get(key);
    if (current) {
      if (!poll || afterMutation) {
        current.again = true;
        current.poll &&= poll;
      }
      return current.promise;
    }
    const entry = { again: false, poll, promise: undefined };
    pending.set(key, entry);
    entry.promise = (async () => {
      try {
        do {
          entry.again = false;
          await read(key, { poll: entry.poll, isCurrent: () => !entry.again });
        } while (entry.again);
      } finally {
        pending.delete(key);
      }
    })();
    return entry.promise;
  };
}
