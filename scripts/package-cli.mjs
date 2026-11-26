import { execFileSync } from "node:child_process";
import { access, mkdtemp, cp, mkdir, readFile, writeFile, rm, chmod, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import {
  cliDependencies,
  cliShrinkwrap,
  productionPackages,
  assertArchiveIntegrity
} from "./cli-package-lock.mjs";

const arguments_ = process.argv.slice(2);
if (arguments_.length) throw new Error("Usage: node scripts/package-cli.mjs");
const stage = await mkdtemp(join(tmpdir(), "formicand-cli-package-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const optionalSourceFiles = new Set(["licenses", "ROADMAP.md", "ROADMAP.en.md"]);
try {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
  const dependencies = cliDependencies(pkg, lock);
  const files = [
    "dist/src",
    "dist/cli-ui-manifest.json",
    "dist/scripts/data-home.cjs",
    "dist/web/assets/agent-names.js",
    ".pi/extensions",
    ".pi/runtime",
    ".pi/prompts",
    ".pi/skills",
    "scripts/formicand.mjs",
    "scripts/data-home.cjs",
    "scripts/file-search.mjs",
    "scripts/file-search.d.mts",
    "scripts/search-tool-adapter.mjs",
    "scripts/cli-branding.mjs",
    "scripts/cli-information.mjs",
    "scripts/cli-startup-error.mjs",
    "scripts/cli-ui-compatibility.mjs",
    "scripts/cli-ui-policy.json",
    "scripts/cli-ui-boot.mjs",
    "scripts/cli-shell-policy.json",
    "scripts/cli-shell-compatibility.mjs",
    "scripts/cli-shell-boot.mjs",
    "scripts/cli-session.mjs",
    "scripts/cli-session-export.mjs",
    "scripts/cli-session.d.mts",
    "scripts/cli-session-picker.mjs",
    "scripts/update.mjs",
    "scripts/update-source.mjs",
    "scripts/start-pi.mjs",
    "scripts/start-pi-runtime.mjs",
    "scripts/cli-runtime-host.mjs",
    "scripts/main-session.mjs",
    "scripts/main-worker.mjs",
    "scripts/main-capacity-gate.mjs",
    "scripts/read-attachment.py",
    // The product entry links the evaluation guide; only the page travels, never
    // the harness, sample repository or hidden checks beside it.
    "scripts/eval/README.md",
    "README.md",
    "README.zh-CN.md",
    "AGENTS.md",
    "AGENTS.en.md",
    "CLAUDE.md",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "GLOSSARY.md",
    "licenses",
    "docs",
    "ROADMAP.md",
    "ROADMAP.en.md",
    "CONTRIBUTING.md",
    "CONTRIBUTING.en.md",
    "config.example.json"
  ];
  for (const file of files) {
    try {
      await access(file);
    } catch (error) {
      if (error.code === "ENOENT" && optionalSourceFiles.has(file)) continue;
      throw error;
    }
    await mkdir(join(stage, file, ".."), { recursive: true });
    await cp(file, join(stage, file), {
      recursive: true,
      filter: (path) =>
        !relative(process.cwd(), path).split(sep).includes("node_modules") &&
        !/^dist\/src\/(?:tools\/science(?:\/|\.|-|$)|runtime\/science-|dashboard\/science-settings)/.test(
          relative(process.cwd(), path).split(sep).join("/")
        ) &&
        !path.endsWith(".map") &&
        !path.endsWith(".DS_Store") &&
        !path.endsWith("formicand-computer-use") &&
        !path.endsWith("formicand-computer-use.sha256") &&
        !path.endsWith("formicand-speech-input") &&
        !path.endsWith("formicand-speech-input.sha256") &&
        !path.endsWith("formicand-icon.png")
    });
  }
  await chmod(join(stage, "scripts/formicand.mjs"), 0o755);
  // Local tgz consumers do not consistently honor registry shrinkwrap metadata.
  // Bundle the portable tested tree. esbuild's pristine JS installer downloads
  // its exact, hash-checked native runtime for the consumer's OS/CPU.
  // Nested production packages are copied from their own lock entries.
  for (const path of productionPackages(lock)) {
    const source = resolve(path);
    await mkdir(join(stage, path, ".."), { recursive: true });
    if (path === "node_modules/esbuild") {
      // npm postinstall replaces bin/esbuild with the build host's binary. Never
      // distribute that mutated directory: recover the original locked archive.
      const entry = lock.packages[path];
      const [runtime] = JSON.parse(
        execFileSync(
          npm,
          [
            "pack",
            `esbuild@${entry.version}`,
            "--json",
            "--ignore-scripts",
            "--prefer-offline",
            "--pack-destination",
            stage
          ],
          { cwd: stage, encoding: "utf8", maxBuffer: 1024 * 1024 }
        )
      );
      const archive = join(stage, runtime.filename);
      assertArchiveIntegrity(await readFile(archive), entry.integrity);
      await mkdir(join(stage, path), { recursive: true });
      execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", join(stage, path)]);
      await rm(archive);
      continue;
    }
    await cp(source, join(stage, path), {
      recursive: true,
      filter: (file) => !relative(source, file).split(sep).includes("node_modules")
    });
  }
  const manifest = {
    name: "formicand-cli",
    version: pkg.version,
    type: "module",
    description: "Formicand local multi-agent CLI harness",
    license: "MIT",
    repository: pkg.repository,
    bugs: pkg.bugs,
    homepage: pkg.homepage,
    engines: pkg.engines,
    bin: {
      formicand: "scripts/formicand.mjs"
    },
    dependencies,
    overrides: pkg.overrides,
    bundleDependencies: Object.keys(dependencies),
    files: [
      "dist",
      ".pi",
      "scripts",
      "docs",
      "README.md",
      "README.zh-CN.md",
      "AGENTS.md",
      "AGENTS.en.md",
      "CLAUDE.md",
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "GLOSSARY.md",
      "licenses",
      "config.example.json",
      "npm-shrinkwrap.json",
      "build-info.json",
      "ROADMAP.md",
      "ROADMAP.en.md",
      "CONTRIBUTING.md",
      "CONTRIBUTING.en.md"
    ]
  };
  await writeFile(join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  const shrinkwrap = cliShrinkwrap(manifest, lock);
  await writeFile(join(stage, "npm-shrinkwrap.json"), JSON.stringify(shrinkwrap, null, 2) + "\n");
  let commit = "unknown",
    dirty = true;
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim());
    // eslint-disable-next-line no-restricted-syntax -- 源码归档里没有 .git，build-info 记为 unknown 而不是让打包失败
  } catch {
    /* Archives may not contain Git metadata. */
  }
  await writeFile(
    join(stage, "build-info.json"),
    JSON.stringify(
      {
        version: pkg.version,
        commit,
        dirty,
        distribution: "release",
        builtAt: new Date().toISOString()
      },
      null,
      2
    )
  );
  const destination = resolve(process.env.FORMICAND_PACKAGE_DIR ?? "release");
  await mkdir(destination, { recursive: true });
  const [result] = JSON.parse(
    execFileSync(npm, ["pack", "--json", "--ignore-scripts", "--pack-destination", destination], {
      cwd: stage,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024
    })
  );
  if (result.files.some(({ path }) => /^(\.formicand|\.tools|desktop|task-[^/]+)\//.test(path)))
    throw new Error("CLI 包中发现禁止分发的目录");
  const filename = `formicand-cli-${pkg.version}.tgz`;
  const path = join(destination, filename);
  await rename(join(destination, result.filename), path);
  const digest = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  await writeFile(`${path}.sha256`, `${digest}  ${filename}\n`);
  console.log(
    `CLI package ready: ${path}\nSource commit: ${commit}${dirty ? " (working tree has changes; verify before distributing)" : ""}`
  );
} finally {
  await rm(stage, { recursive: true, force: true });
}
