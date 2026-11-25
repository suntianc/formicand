import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import {
  assertArchiveIntegrity,
  cliDependencies,
  cliShrinkwrap,
  productionPackages
} from "../scripts/cli-package-lock.mjs";

const parentName = "formicand-packaging-fixture-parent";
const childName = "formicand-packaging-fixture-child";
const nestedName = "formicand-packaging-fixture-nested";

function packageLock() {
  return {
    lockfileVersion: 2,
    packages: {
      "": { name: "source-project", devDependencies: { "dev-sentinel": "1.0.0" } },
      [`node_modules/${parentName}`]: {
        version: "1.0.0",
        dependencies: { [childName]: "^1.0.0", [nestedName]: "1.0.0", esbuild: "^0.28.0" }
      },
      [`node_modules/${childName}`]: {
        version: "2.0.4",
        resolved: "https://registry.invalid/child.tgz",
        integrity: "sha512-tested-override"
      },
      "node_modules/esbuild": { version: "0.28.2" },
      [`node_modules/${parentName}/node_modules/${nestedName}`]: { version: "1.0.0" },
      "node_modules/@esbuild/fake-platform": {
        version: "0.28.2",
        optional: true,
        os: ["fixture-os"],
        cpu: ["fixture-cpu"]
      },
      "node_modules/dev-sentinel": { version: "1.0.0", dev: true },
      [`node_modules/${parentName}/node_modules/dev-sentinel`]: { version: "1.0.0", dev: true }
    }
  };
}

test("CLI lock pins tested direct/platform versions and retains only production shrinkwrap topology", () => {
  const lock = packageLock();
  const source = { dependencies: { [parentName]: "^1.0.0" } };
  const dependencies = cliDependencies(source, lock);
  assert.deepEqual(dependencies, { [parentName]: "1.0.0", esbuild: "0.28.2" });
  const manifest = {
    name: "formicand-packaging-fixture-cli",
    version: "1.0.0",
    license: "MIT",
    engines: { node: ">=22.19.0" },
    bin: { "formicand-packaging-fixture": "cli.cjs" },
    dependencies
  };
  const shrinkwrap = cliShrinkwrap(manifest, lock);
  assert.equal(shrinkwrap.lockfileVersion, 3);
  assert.deepEqual(shrinkwrap.packages[""], manifest);
  assert.equal(shrinkwrap.packages[`node_modules/${childName}`].version, "2.0.4");
  assert.equal(shrinkwrap.packages[`node_modules/${childName}`].integrity, "sha512-tested-override");
  assert.ok(shrinkwrap.packages["node_modules/@esbuild/fake-platform"].optional);
  assert.ok(!Object.keys(shrinkwrap.packages).some((path) => path.includes("dev-sentinel")));
  assert.deepEqual(productionPackages(lock), [
    `node_modules/${parentName}`,
    `node_modules/${childName}`,
    "node_modules/esbuild",
    `node_modules/${parentName}/node_modules/${nestedName}`
  ]);
  const withoutPlatformRuntime = structuredClone(lock);
  withoutPlatformRuntime.packages["node_modules/esbuild"].dev = true;
  assert.deepEqual(cliDependencies(source, withoutPlatformRuntime), { [parentName]: "1.0.0" });
});

test("pristine runtime archives reject corruption, missing integrity and unsupported hashes", () => {
  const bytes = Buffer.from("locked runtime archive");
  for (const algorithm of ["sha1", "sha256", "sha384", "sha512"]) {
    const integrity = `${algorithm}-${createHash(algorithm).update(bytes).digest("base64")}`;
    assert.doesNotThrow(() => assertArchiveIntegrity(bytes, integrity));
    assert.throws(() => assertArchiveIntegrity(Buffer.from("corrupted archive"), integrity), /integrity/);
  }
  for (const integrity of [undefined, "", "md5-unsupported", "sha512-malformed"])
    assert.throws(() => assertArchiveIntegrity(bytes, integrity), /integrity/);
});

test("CLI packaging rejects unsupported locks, missing direct dependencies and unsafe/platform bundle entries", () => {
  const source = { dependencies: { [parentName]: "^1.0.0" } };
  for (const lock of [{ lockfileVersion: 1 }, { lockfileVersion: 3 }]) {
    assert.throws(() => cliDependencies(source, lock), /v2\/v3/);
    assert.throws(() => productionPackages(lock), /v2\/v3/);
    assert.throws(() => cliShrinkwrap(source, lock), /v2\/v3/);
  }
  for (const entry of [undefined, {}, { version: "1.0.0", dev: true }]) {
    const lock = packageLock();
    lock.packages[`node_modules/${parentName}`] = entry;
    assert.throws(() => cliDependencies(source, lock), /Missing production lock entry/);
    assert.throws(() => cliShrinkwrap(source, lock), /Missing production lock entry/);
  }
  for (const [path, entry] of [
    ["outside", { version: "1.0.0" }],
    ["node_modules/../private", { version: "1.0.0" }],
    ["node_modules/linked", { version: "1.0.0", link: true }],
    ["node_modules/unknown-native", { version: "1.0.0", os: ["darwin"] }],
    ["node_modules/unknown-native", { version: "1.0.0", cpu: ["arm64"] }]
  ]) {
    const lock = packageLock();
    lock.packages[path] = entry;
    assert.throws(() => productionPackages(lock), /Cannot bundle|explicit portable packaging/);
  }
});

async function npmCliPath() {
  if (process.env.npm_execpath?.endsWith(".js")) return realpath(process.env.npm_execpath);
  for (const folder of (process.env.PATH ?? "").split(delimiter)) {
    try {
      const candidate = await realpath(join(folder, "npm"));
      if (candidate.endsWith(".js")) return candidate;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
    }
  }
  throw new Error("Packaging regression requires the repository's npm installation on PATH");
}

async function put(root, file, content) {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), typeof content === "string" ? content : JSON.stringify(content));
}

test("the actual CLI packer excludes retained Mac helpers and tolerates optional source resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "formicand-cli-content-"));
  try {
    // Copy only public source directories used by the actual packer. No build,
    // installed production dependencies, model configuration or user data.
    for (const directory of ["scripts", ".pi/extensions", ".pi/runtime", ".pi/prompts", ".pi/skills", "docs"])
      await cp(new URL(`../${directory}/`, import.meta.url), join(root, directory), { recursive: true });
    for (const file of [
      "README.md",
      "README.zh-CN.md",
      "AGENTS.md",
      "AGENTS.en.md",
      "CLAUDE.md",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "GLOSSARY.md",
      "CONTRIBUTING.md",
      "CONTRIBUTING.en.md",
      "config.example.json"
    ]) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await cp(new URL(`../${file}`, import.meta.url), join(root, file));
    }
    await put(root, "desktop/main.cjs", "// Desktop entrypoint must not enter the CLI package.\n");
    await put(
      root,
      "docs/site/node_modules/@esbuild/darwin-arm64/bin/esbuild",
      "Host-only documentation build dependency excluded from CLI archives"
    );
    const version = "0.0.0";
    await put(root, "package.json", {
      name: "cli-source-fixture",
      version,
      dependencies: {},
      engines: { node: ">=22.19.0" },
      license: "MIT"
    });
    await put(root, "package-lock.json", {
      name: "cli-source-fixture",
      version,
      lockfileVersion: 3,
      packages: { "": { name: "cli-source-fixture", version, dependencies: {} } }
    });
    for (const file of [
      "dist/src/gui/formicand-computer-use",
      "dist/src/gui/formicand-computer-use.sha256",
      "dist/src/gui/formicand-speech-input",
      "dist/src/gui/formicand-speech-input.sha256",
      "dist/src/gui/formicand-icon.png",
      "dist/src/gui/driver.js.map"
    ])
      await put(root, file, "Mac/generated sentinel excluded from portable CLI");
    for (const file of [
      "dist/cli-ui-manifest.json",
      "dist/src/gui/driver.js",
      "dist/scripts/data-home.cjs",
      "dist/web/assets/agent-names.js"
    ])
      await put(root, file, "// portable source fixture\n");
    await put(root, "dist/src/tools/science/runner.py", "retired runtime sentinel");
    for (const name of ["npmrc", "global-npmrc"]) await put(root, name, "");
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^(?:npm_config_|FORMICAND_|PI_|FORMICAND_)/i.test(key))
    );
    Object.assign(env, {
      FORMICAND_PACKAGE_DIR: join(root, "archives"),
      npm_config_userconfig: join(root, "npmrc"),
      npm_config_globalconfig: join(root, "global-npmrc"),
      npm_config_cache: join(root, "npm-cache"),
      npm_config_offline: "true",
      npm_config_registry: "https://registry.invalid",
      npm_config_update_notifier: "false"
    });
    execFileSync(process.execPath, [join(root, "scripts/package-cli.mjs")], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024
    });
    const archive = join(root, "archives", `formicand-cli-${version}.tgz`);
    const manifest = JSON.parse(
      execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" })
    );
    assert.equal(manifest.name, "formicand-cli");
    assert.deepEqual(manifest.bin, {
      formicand: "scripts/formicand.mjs",
      formicand: "scripts/formicand.mjs"
    });
    const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
    // The worker and the Pi runtime load this gate at run time, so the archive
    // has to carry it or an external-capacity CLI fails in the consumer's tree.
    assert.ok(files.includes("package/scripts/main-capacity-gate.mjs"));
    assert.ok(!files.includes("package/desktop/main.cjs"));
    assert.ok(!files.some((path) => path.startsWith("package/docs/site/node_modules/")));
    for (const name of [
      "cad",
      "blender",
      "pptist",
      "presentations",
      "make-a-deck",
      "office-harness",
      "creative-design",
      "iterative-optimization",
      "machine-learning-model-search",
      "workspace-explore"
    ])
      assert.ok(
        !files.some((file) => file.startsWith(`package/.pi/skills/${name}/`)),
        `CLI archive includes retired ${name}`
      );
    assert.ok(
      !files.some((file) =>
        /(?:text-editor|text-runtime-adapter|text-outline|text-document-session)/.test(file)
      ),
      "CLI archive excludes editor implementations and contract fixtures"
    );
    assert.ok(files.includes("package/dist/src/gui/driver.js"));
    assert.ok(files.includes("package/.pi/skills/cua/SKILL.md"), "CLI archive excludes cua");
    // The cua skill and the product notices cite guides by relative path; an
    // installed CLI resolves them against the same tree, so the targets ship too.
    assert.ok(files.includes("package/docs/en/README.md"), "CLI archive carries the CUA guide");
    assert.ok(files.includes("package/GLOSSARY.md"), "CLI archive carries the product glossary");

    assert.equal(
      files.some((path) => /formicand-(?:speech-input|computer-use)(?:\.sha256)?$/.test(path)),
      false
    );
    assert.equal(
      files.some((path) => /\.map$|formicand-icon\.png$/.test(path)),
      false
    );
    const license = "licenses/pi-0.87.1-LICENSE.txt";
    assert.equal(files.includes(`package/${license}`), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Seed the installed npm's own HTTP cache, so this resolver test uses neither a
// user's cache/configuration nor a mock server that requires network permissions.
async function cachePackage(npmCli, cache, manifest, bytes) {
  const npmRequire = createRequire(npmCli);
  const cacache = npmRequire("cacache");
  const registry = "https://registry.invalid";
  const tarball = `${registry}/${manifest.name}/-/${manifest.name.split("/").at(-1)}-${manifest.version}.tgz`;
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  const packument = {
    name: manifest.name,
    "dist-tags": { latest: manifest.version },
    versions: {
      [manifest.version]: { ...manifest, dist: { tarball, integrity } }
    }
  };
  const cachePath = join(cache, "_cacache");
  await cacache.put(cachePath, `pacote:tarball:${tarball}`, bytes, { integrity });
  const url = `${registry}/${manifest.name.replace("/", "%2f")}`;
  for (const accept of [
    "application/json",
    "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*"
  ]) {
    await cacache.put(cachePath, `make-fetch-happen:request-cache:${url}`, JSON.stringify(packument), {
      metadata: {
        time: Date.now(),
        url,
        reqHeaders: { accept },
        resHeaders: {
          "content-type": "application/json",
          "cache-control": "public, max-age=31536000",
          date: new Date().toUTCString()
        },
        options: { compress: true }
      }
    });
  }
  return { resolved: tarball, integrity };
}

test(
  "portable CLI archive installs an overridden bundle and exact platform fallback locally/globally offline",
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "formicand-packaging-regression-"));
    try {
      const npmCli = await npmCliPath();
      const cache = join(root, "cache");
      const source = join(root, "source");
      const stage = join(root, "stage");
      const archive = join(root, "archive");
      await mkdir(archive, { recursive: true });
      await put(root, "npmrc", "");
      await put(root, "global-npmrc", "");
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key))
      );
      const npm = (cwd, args) =>
        execFileSync(
          process.execPath,
          [
            npmCli,
            ...args,
            "--offline",
            "--no-audit",
            "--no-fund",
            "--update-notifier=false",
            "--registry=https://registry.invalid",
            `--userconfig=${join(root, "npmrc")}`,
            `--globalconfig=${join(root, "global-npmrc")}`,
            `--cache=${cache}`
          ],
          { cwd, env, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024 }
        );

      const platform = {
        name: "@esbuild/fake-platform",
        version: "0.28.2",
        main: "index.cjs",
        os: [process.platform],
        cpu: [process.arch]
      };
      await put(root, "platform-runtime/package.json", platform);
      await put(root, "platform-runtime/index.cjs", 'module.exports = "portable-runtime-0.28.2";');
      const [runtimePack] = JSON.parse(
        npm(join(root, "platform-runtime"), [
          "pack",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          archive
        ])
      );
      const runtimeLock = await cachePackage(
        npmCli,
        cache,
        platform,
        await readFile(join(archive, runtimePack.filename))
      );

      const lock = packageLock();
      Object.assign(lock.packages["node_modules/@esbuild/fake-platform"], runtimeLock);
      await put(source, `node_modules/${parentName}/package.json`, {
        name: parentName,
        ...lock.packages[`node_modules/${parentName}`],
        main: "index.cjs"
      });
      await put(
        source,
        `node_modules/${parentName}/index.cjs`,
        `module.exports = { child: require("${childName}/package.json").version, nested: require("${nestedName}/package.json").version };`
      );
      await put(source, `node_modules/${childName}/package.json`, {
        name: childName,
        version: "2.0.4"
      });
      await put(source, `node_modules/${parentName}/node_modules/${nestedName}/package.json`, {
        name: nestedName,
        version: "1.0.0"
      });
      for (const path of [
        "node_modules/dev-sentinel",
        `node_modules/${parentName}/node_modules/dev-sentinel`,
        "node_modules/@esbuild/fake-platform"
      ]) {
        await put(source, `${path}/package.json`, { name: path.split("/").at(-1), version: "9.9.9" });
        await put(source, `${path}/forbidden-sentinel.txt`, "must not ship");
      }
      const esbuild = {
        name: "esbuild",
        version: "0.28.2",
        main: "index.cjs",
        optionalDependencies: { [platform.name]: "0.28.2" },
        scripts: { postinstall: "node install.cjs" }
      };
      const pristineRuntime = join(root, "pristine-runtime");
      await put(pristineRuntime, "package.json", esbuild);
      await put(pristineRuntime, "index.cjs", 'module.exports = require("./downloaded.cjs");');
      await put(pristineRuntime, "bin/esbuild", "#!/usr/bin/env node\n// portable registry stub\n");
      // Model esbuild's official missing optional binary fallback: an exact npm
      // install in a temporary child project, followed by a portable runtime copy.
      await put(
        pristineRuntime,
        "install.cjs",
        [
          'const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");',
          'const dir = path.join(__dirname, "npm-install"); fs.mkdirSync(dir);',
          'fs.writeFileSync(path.join(dir, "package.json"), "{}");',
          "const env = { ...process.env, npm_config_global: undefined };",
          `cp.execFileSync(process.execPath, [${JSON.stringify(npmCli)}, "install", "--prefer-offline", "--no-audit", "--no-fund", "${platform.name}@" + require("./package.json").version], { cwd: dir, env, stdio: "pipe" });`,
          `fs.copyFileSync(path.join(dir, "node_modules", "${platform.name}", "index.cjs"), path.join(__dirname, "downloaded.cjs"));`,
          "fs.rmSync(dir, { recursive: true, force: true });"
        ].join("\n")
      );
      const [pristinePack] = JSON.parse(
        npm(pristineRuntime, ["pack", "--ignore-scripts", "--json", "--pack-destination", archive])
      );
      assertArchiveIntegrity(await readFile(join(archive, pristinePack.filename)), pristinePack.integrity);
      await put(source, "node_modules/esbuild/package.json", esbuild);
      await put(source, "node_modules/esbuild/bin/esbuild", "builder-native-sentinel");
      for (const path of productionPackages(lock)) {
        if (path === "node_modules/esbuild") continue;
        const from = join(source, path);
        await mkdir(dirname(join(stage, path)), { recursive: true });
        await cp(from, join(stage, path), {
          recursive: true,
          filter: (file) => !relative(from, file).split(sep).includes("node_modules")
        });
      }
      await mkdir(join(stage, "node_modules/esbuild"), { recursive: true });
      execFileSync("tar", [
        "-xzf",
        join(archive, pristinePack.filename),
        "--strip-components=1",
        "-C",
        join(stage, "node_modules/esbuild")
      ]);
      const dependencies = cliDependencies({ dependencies: { [parentName]: "^1.0.0" } }, lock);
      const manifest = {
        name: "formicand-packaging-fixture-cli",
        version: "1.0.0",
        bin: { "formicand-packaging-fixture": "cli.cjs" },
        dependencies,
        bundleDependencies: Object.keys(dependencies),
        overrides: { [childName]: "2.0.4" },
        files: ["cli.cjs", "npm-shrinkwrap.json"]
      };
      await put(stage, "package.json", manifest);
      await put(stage, "npm-shrinkwrap.json", cliShrinkwrap(manifest, lock));
      await put(
        stage,
        "cli.cjs",
        `#!/usr/bin/env node\nconsole.log(JSON.stringify({ ...require("${parentName}"), runtime: require("esbuild") }));\n`
      );
      await chmod(join(stage, "cli.cjs"), 0o755);
      const [packed] = JSON.parse(
        npm(stage, ["pack", "--ignore-scripts", "--json", "--pack-destination", archive])
      );
      const archivePaths = packed.files.map(({ path }) => path);
      assert.ok(archivePaths.includes(`node_modules/${childName}/package.json`));
      assert.ok(archivePaths.includes(`node_modules/${parentName}/node_modules/${nestedName}/package.json`));
      assert.ok(archivePaths.includes("npm-shrinkwrap.json"));
      assert.ok(!archivePaths.some((path) => /dev-sentinel|forbidden-sentinel|@esbuild/.test(path)));
      assert.ok(archivePaths.includes("node_modules/esbuild/install.cjs"));
      assert.ok(!archivePaths.includes("node_modules/esbuild/downloaded.cjs"));
      assert.ok(packed.bundled.includes("esbuild"));
      const tarball = join(archive, packed.filename);

      for (const mode of ["local", "global"]) {
        const consumer = join(root, mode);
        await put(consumer, "package.json", { name: `fixture-${mode}-consumer`, version: "1.0.0" });
        const prefix = join(root, "prefix");
        npm(consumer, ["install", tarball, ...(mode === "global" ? ["--global", "--prefix", prefix] : [])]);
        const installed =
          mode === "local"
            ? join(consumer, "node_modules", manifest.name)
            : join(prefix, process.platform === "win32" ? "node_modules" : "lib/node_modules", manifest.name);
        const launcher =
          mode === "local"
            ? join(consumer, "node_modules/.bin/formicand-packaging-fixture")
            : join(
                prefix,
                process.platform === "win32"
                  ? "formicand-packaging-fixture"
                  : "bin/formicand-packaging-fixture"
              );
        await access(launcher);
        const output = execFileSync(
          process.platform === "win32" ? process.execPath : launcher,
          process.platform === "win32" ? [join(installed, "cli.cjs")] : [],
          {
            cwd: consumer,
            env,
            encoding: "utf8"
          }
        );
        assert.deepEqual(
          JSON.parse(output),
          { child: "2.0.4", nested: "1.0.0", runtime: "portable-runtime-0.28.2" },
          mode
        );
        assert.match(
          await readFile(join(installed, "node_modules/esbuild/bin/esbuild"), "utf8"),
          /^#!\/usr\/bin\/env node\n\/\/ portable registry stub/
        );
        await assert.rejects(access(join(installed, "node_modules/dev-sentinel")), { code: "ENOENT" });
        await assert.rejects(
          access(join(installed, `node_modules/${parentName}/node_modules/dev-sentinel`)),
          { code: "ENOENT" }
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
