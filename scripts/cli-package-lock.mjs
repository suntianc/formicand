import { createHash } from "node:crypto";

// Published CLIs need a shrinkwrap: consumer npm ignores a dependency's overrides.
// Keep the tested production topology and integrity, including overridden versions.
export function cliDependencies(source, lock) {
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages)
    throw new Error("CLI packaging requires a v2/v3 package-lock.json");
  const names = Object.keys(source.dependencies);
  // esbuild is transitive via Pi and must be installed for the consumer's OS/CPU.
  // Promote its tested version so even local archives resolve this edge exactly.
  if (lock.packages["node_modules/esbuild"]?.dev !== true && lock.packages["node_modules/esbuild"])
    names.push("esbuild");
  return Object.fromEntries(
    [...new Set(names)].map((name) => {
      const entry = lock.packages[`node_modules/${name}`];
      if (!entry?.version || entry.dev === true) throw new Error(`Missing production lock entry: ${name}`);
      return [name, entry.version];
    })
  );
}

export function cliShrinkwrap(manifest, lock) {
  cliDependencies(manifest, lock);
  return {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: manifest.name,
        version: manifest.version,
        license: manifest.license,
        engines: manifest.engines,
        bin: manifest.bin,
        dependencies: manifest.dependencies,
        ...(manifest.optionalDependencies && { optionalDependencies: manifest.optionalDependencies })
      },
      ...Object.fromEntries(
        Object.entries(lock.packages).filter(([path, entry]) => path && entry.dev !== true)
      )
    }
  };
}

// A platform package is only installable on the OS/CPU it was built for. Copying
// it from the build host would give every consumer this host's native binary.
function isPlatformDependency(entry) {
  return Boolean(entry.os || entry.cpu);
}

// Node resolves a dependency from the package's own node_modules first, then
// walks up to the root node_modules.
function resolveDependency(packages, path, name) {
  let base = path;
  while (true) {
    const candidate = `${base}/node_modules/${name}`;
    if (packages[candidate]) return candidate;
    const boundary = base.lastIndexOf("/node_modules/");
    if (boundary < 0) break;
    base = base.slice(0, boundary);
  }
  return packages[`node_modules/${name}`] ? `node_modules/${name}` : null;
}

/**
 * Production packages to bundle into the archive.
 *
 * Platform-restricted packages are deliberately left out: npm-shrinkwrap.json
 * still pins their exact version and integrity, so the consumer's npm installs
 * the archive for its own OS/CPU. Their subtree is not bundled either, because
 * it only resolves next to the platform binary the consumer installs.
 */
export function productionPackages(lock, dependencies) {
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages)
    throw new Error("CLI packaging requires a v2/v3 package-lock.json");
  if (!dependencies) throw new Error("CLI packaging requires the production dependencies");
  const production = Object.entries(lock.packages).filter(([path, entry]) => path && entry.dev !== true);
  for (const [path, entry] of production) {
    if (!/^node_modules\//.test(path) || path.split("/").includes("..") || entry.link)
      throw new Error(`Cannot bundle non-registry production dependency: ${path}`);
  }
  const bundled = new Set();
  const queue = [];
  for (const name of Object.keys(dependencies)) {
    const path = `node_modules/${name}`;
    if (!lock.packages[path]?.version || lock.packages[path].dev === true)
      throw new Error(`Missing production lock entry: ${name}`);
    queue.push(path);
  }
  while (queue.length) {
    const path = queue.shift();
    if (bundled.has(path) || isPlatformDependency(lock.packages[path])) continue;
    bundled.add(path);
    const entry = lock.packages[path];
    for (const name of Object.keys(entry.dependencies ?? {})) {
      const resolved = resolveDependency(lock.packages, path, name);
      if (!resolved || lock.packages[resolved].dev === true)
        throw new Error(`Missing production lock entry: ${name} (required by ${path})`);
      // npm treats a bundled tree as complete and does not fetch a bundled
      // package's platform dependency for the consumer. Such a tree needs a
      // dedicated strategy instead of silently producing a broken archive.
      if (isPlatformDependency(lock.packages[resolved]))
        throw new Error(`Platform dependency needs an explicit portable packaging strategy: ${resolved}`);
      queue.push(resolved);
    }
    for (const name of [
      ...Object.keys(entry.optionalDependencies ?? {}),
      ...Object.keys(entry.peerDependencies ?? {})
    ]) {
      const resolved = resolveDependency(lock.packages, path, name);
      if (resolved && lock.packages[resolved].dev !== true) queue.push(resolved);
    }
  }
  return production.map(([path]) => path).filter((path) => bundled.has(path));
}

/** Direct dependencies that the archive actually carries; the rest are installed by npm. */
export function cliBundleDependencies(dependencies, packages) {
  const bundled = new Set(packages);
  return Object.keys(dependencies).filter((name) => bundled.has(`node_modules/${name}`));
}

export function assertArchiveIntegrity(bytes, integrity) {
  const matches =
    typeof integrity === "string" &&
    integrity.split(/\s+/).some((expected) => {
      const match = /^(sha(?:1|256|384|512))-(.+)$/.exec(expected);
      return match && createHash(match[1]).update(bytes).digest("base64") === match[2];
    });
  if (!matches) throw new Error("Runtime archive does not match package-lock integrity");
}
