const resources = new WeakMap();

/** Release in reverse acquisition order so files and directories outlive their users. */
export function deferCleanup(t, release) {
  let stack = resources.get(t);
  if (!stack) {
    stack = [];
    resources.set(t, stack);
    t.after(() => releaseFixtureResources(stack));
  }
  stack.push(release);
}

/** Also used by standalone fixture scripts that do not have a test context. */
export async function releaseFixtureResources(stack) {
  const errors = [];
  for (const close of stack.reverse()) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, errors.map(String).join("\n"));
}
