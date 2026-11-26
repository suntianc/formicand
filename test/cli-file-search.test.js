import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { promisify } from "node:util";
import { findFiles, grepFiles, runDiskSearch, runFileSearch } from "../scripts/file-search.mjs";
import { installSearchToolAdapters, parseSearchToolArguments } from "../scripts/search-tool-adapter.mjs";

const exec = promisify(execFile);
const cli = resolve("scripts/formicand.mjs");
const portable = ["darwin", "linux"].includes(process.platform);
const initialPath = process.env.PATH ?? "";
const adapterHead = /(?:search-tool-adapter\.mjs|Pi (?:fd|rg) adapter)/;

async function findRealTool(name) {
  for (const directory of initialPath.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    let head = "";
    try {
      head = (await readFile(candidate, "utf8")).slice(0, 4096);
    } catch (error) {
      if (error.code !== "EISDIR") continue;
    }
    if (adapterHead.test(head)) continue;
    try {
      const { stdout } = await exec(candidate, ["--version"], { timeout: 5000 });
      if (name === "fd" ? /^fd \d+\./.test(stdout) : /^ripgrep \d+\./.test(stdout)) return candidate;
    } catch (error) {
      if (error.code !== undefined) continue;
    }
  }
  return undefined;
}

const nativeTools = { fd: await findRealTool("fd"), rg: await findRealTool("rg") };
const realPaths = [
  ...new Set(
    [
      nativeTools.fd && dirname(nativeTools.fd),
      nativeTools.rg && dirname(nativeTools.rg),
      initialPath
    ].filter(Boolean)
  )
].join(delimiter);
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const sortedPaths = (result) => [...result.paths].sort();
function setTestPath(t, value) {
  const previous = process.env.PATH;
  process.env.PATH = value;
  t.after(() => {
    process.env.PATH = previous;
  });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "formicand-file-search-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, text) => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  };
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(?:FORMICAND_|PI_|FORMICAND_)/.test(name))
  );
  Object.assign(env, {
    FORMICAND_HOME: join(root, "user"),
    PI_OFFLINE: "1",
    FORMICAND_DISABLE_MAIN_GUARDIAN: "1",
    FORMICAND_DISABLE_SESSION_TITLES: "1"
  });
  return { root, put, env };
}

test("portable file search handles globs, hidden files, nested ignores, exclusions and result limits", async (t) => {
  const f = await fixture(t);
  await f.put(".gitignore", "ignored/\n*.tmp\n");
  await f.put("hello.txt", "hello\n");
  await f.put(".hidden.txt", "hidden\n");
  await f.put("ignored/secret.txt", "ignored\n");
  await f.put("node_modules/not-user-source.txt", "ignored\n");
  await f.put(".git/not-user-source.txt", "ignored\n");
  await f.put("src/.gitignore", "*.txt\n!included.txt\n");
  await f.put("src/included.txt", "included\n");
  await f.put("src/excluded.txt", "excluded\n");
  await f.put("src/item.tmp", "ignored\n");
  await f.put("src/code.js", "source\n");
  if (portable) await symlink(join(f.root, "hello.txt"), join(f.root, "shortcut.txt"));
  const found = await runFileSearch("find", { pattern: "*.txt" }, { cwd: f.root });
  assert.deepEqual(found, { paths: [".hidden.txt", "hello.txt", "src/included.txt"], limitReached: false });
  assert.deepEqual((await findFiles({ pattern: "src/**/*.js" }, f.root)).paths, ["src/code.js"]);
  assert.deepEqual(await findFiles({ pattern: "*.txt", limit: 1 }, f.root), {
    paths: [".hidden.txt"],
    limitReached: true
  });
  assert.equal((await findFiles({ pattern: "*.js", limit: 1 }, f.root)).limitReached, false);
});

test("search respects parent repository ignore rules and nested repository boundaries", async (t) => {
  const f = await fixture(t);
  await f.put(".git/marker", "fixture");
  await f.put(".gitignore", "*.txt\n");
  await f.put("project/parent-ignored.txt", "ignored");
  await f.put("project/source.js", "source");
  await f.put("project/nested/.git/marker", "fixture");
  await f.put("project/nested/visible.txt", "visible");
  assert.deepEqual((await findFiles({ pattern: "**/*" }, join(f.root, "project"))).paths, [
    "nested/visible.txt",
    "source.js"
  ]);
});

test("portable content search handles literal/regex matches, context, ignored/binary/large files and limits", async (t) => {
  const f = await fixture(t);
  await f.put(".gitignore", "ignored.txt\n");
  await f.put("hello.txt", "first\r\nHello [world]\r\nlast\r\nHELLO\r\n");
  await f.put("ignored.txt", "Hello\n");
  await f.put("binary.txt", Buffer.from("Hello\0binary"));
  await f.put("large.txt", Buffer.alloc(4 * 1024 * 1024 + 1, "a"));
  const literal = await runFileSearch(
    "grep",
    { pattern: "Hello [world]", literal: true, context: 1 },
    { cwd: f.root }
  );
  assert.equal(literal.matchCount, 1);
  assert.equal(literal.text, "hello.txt-1- first\nhello.txt:2: Hello [world]\nhello.txt-3- last");
  assert.deepEqual(literal.skippedFiles, ["large.txt"]);
  const insensitive = await grepFiles({ pattern: "^hello", ignoreCase: true, glob: "hello.txt" }, f.root);
  assert.equal(insensitive.matchCount, 2);
  assert.equal(insensitive.matches[1].lineNumber, 4);
  assert.equal((await grepFiles({ pattern: "Hello", path: "ignored.txt" }, f.root)).matchCount, 1);
  const limited = await grepFiles({ pattern: "Hello", ignoreCase: true, limit: 1 }, f.root);
  assert.equal(limited.matchCount, 1);
  assert.equal(limited.limitReached, true);
  assert.equal((await grepFiles({ pattern: "absent" }, f.root)).matchCount, 0);
  await f.put("overlap.txt", "Hello\nHello\nlast\n");
  const overlapping = await grepFiles({ pattern: "Hello", path: "overlap.txt", context: 1 }, f.root);
  assert.equal(overlapping.text, "overlap.txt:1: Hello\noverlap.txt:2: Hello\noverlap.txt-3- last");
  await f.put("long.txt", `${"Hello" + "x".repeat(2000)}\n`.repeat(100));
  const bounded = await grepFiles({ pattern: "Hello", path: "long.txt" }, f.root);
  assert.equal(bounded.outputLimitReached, true);
  assert.equal(bounded.limitReached, false);
  assert.equal(bounded.linesTruncated, true);
  assert.ok(Buffer.byteLength(bounded.text) <= 64 * 1024);
});

test("file search rejects invalid inputs and terminates aborted or stalled workers", async (t) => {
  const f = await fixture(t);
  await f.put("hello.txt", "a".repeat(100) + "!");
  await assert.rejects(
    runFileSearch("find", { pattern: "*", path: "missing" }, { cwd: f.root }),
    /Path not found/
  );
  await assert.rejects(findFiles({ pattern: "*", path: "hello.txt" }, f.root), /must be a directory/);
  for (const limit of [0, -1, 1.1, 20_001, "1"])
    await assert.rejects(findFiles({ pattern: "*", limit }, f.root), /Search limit/);
  await assert.rejects(runFileSearch("grep", { pattern: "[" }, { cwd: f.root }), /regular expression/);
  await assert.rejects(grepFiles({ pattern: "a", context: -1 }, f.root), /context/);
  await assert.rejects(runFileSearch("unknown", {}, { cwd: f.root }), /Unknown/);
  await assert.rejects(runFileSearch("find", { pattern: "*" }, { signal: AbortSignal.abort() }), /aborted/);
  await assert.rejects(
    runFileSearch("grep", { pattern: "(a+)+$" }, { cwd: f.root, timeoutMs: 200 }),
    /timed out/
  );
  const abort = new AbortController();
  const pending = runFileSearch("grep", { pattern: "(a+)+$" }, { cwd: f.root, signal: abort.signal });
  setTimeout(() => abort.abort(), 100);
  await assert.rejects(pending, /aborted/);
  assert.deepEqual((await runFileSearch("find", { pattern: "*.txt" }, { cwd: f.root })).paths, ["hello.txt"]);
});

test("Pi search adapters expose only supported arguments and preserve user-installed tools", async (t) => {
  const f = await fixture(t);
  for (const [tool, args] of [
    ["fd", ["--unknown"]],
    ["rg", ["--files"]],
    ["fd", ["--max-depth"]],
    ["rg", []]
  ])
    assert.throws(() => parseSearchToolArguments(tool, args), /does not support|requires|pattern/);
  assert.deepEqual(await installSearchToolAdapters(join(f.root, "windows"), { platform: "win32" }), {
    supported: false,
    installed: []
  });
  if (!portable) return;
  const agent = join(f.root, "agent's directory with spaces");
  await mkdir(join(agent, "bin"), { recursive: true });
  await writeFile(join(agent, "bin/fd"), "user-owned native fd sentinel");
  const installed = await installSearchToolAdapters(agent);
  assert.deepEqual(installed.installed, ["rg"]);
  assert.equal(await readFile(join(agent, "bin/fd"), "utf8"), "user-owned native fd sentinel");
  const repeated = await installSearchToolAdapters(agent);
  assert.deepEqual(repeated.installed, []);
  assert.equal((await stat(join(agent, "bin/rg"))).mode & 0o777, 0o755);
  assert.match(
    (await exec(join(agent, "bin/rg"), ["--version"], { env: f.env })).stdout,
    /Node.js portable search/
  );
  const linkedAgent = join(f.root, "linked-agent");
  await mkdir(join(linkedAgent, "bin"), { recursive: true });
  await writeFile(join(f.root, "owned-fd"), "#!/bin/sh\n# Formicand Pi search adapter v1\nold target\n");
  await symlink(join(f.root, "owned-fd"), join(linkedAgent, "bin/fd"));
  await installSearchToolAdapters(linkedAgent);
  assert.equal(
    await readFile(join(f.root, "owned-fd"), "utf8"),
    "#!/bin/sh\n# Formicand Pi search adapter v1\nold target\n"
  );
  const migratedAgent = join(f.root, "migrated-agent");
  await mkdir(join(migratedAgent, "bin"), { recursive: true });
  await writeFile(join(migratedAgent, "bin/fd"), "#!/bin/sh\n# Formicand Pi search adapter v1\nold target\n");
  assert.deepEqual((await installSearchToolAdapters(migratedAgent)).installed, ["fd", "rg"]);
  assert.match((await exec(join(migratedAgent, "bin/fd"), ["--version"])).stdout, /Formicand Pi fd adapter/);
});

test(
  "installed adapters support actual Pi file autocomplete and find/grep arguments while offline",
  { skip: !portable },
  async (t) => {
    const f = await fixture(t);
    const agent = join(f.root, "agent");
    const project = join(f.root, "project");
    await f.put("project/hello.txt", "hello fixture\nsecond line\n");
    await f.put("project/nested/deep.txt", "deep fixture\n");
    await f.put("project/pkg/nested/other.txt", "other fixture\n");
    await f.put("project/.git/hidden", "ignored");
    await symlink(project, join(project, "loop"));
    await installSearchToolAdapters(agent);
    const fd = join(agent, "bin/fd");
    const rg = join(agent, "bin/rg");
    const actualAutocomplete = [
      "--base-directory",
      project,
      "--max-results",
      "100",
      "--type",
      "f",
      "--type",
      "d",
      "--follow",
      "--hidden",
      "--exclude",
      ".git",
      "--exclude",
      ".git/*",
      "--exclude",
      ".git/**",
      "--max-depth",
      "1"
    ];
    const completed = await exec(fd, actualAutocomplete, { cwd: project, env: f.env });
    assert.deepEqual(completed.stdout.trim().split("\n"), ["hello.txt", "loop/", "nested/", "pkg/"]);
    const paths = await exec(
      fd,
      [
        "--glob",
        "--color=never",
        "--hidden",
        "--no-require-git",
        "--max-results",
        "10",
        "--full-path",
        "--",
        "**/nested/*.txt",
        project
      ],
      { cwd: project, env: f.env }
    );
    assert.equal(paths.stdout.trim(), "nested/deep.txt\npkg/nested/other.txt");
    // Pi 1.6.1 anchors relative path globs at the search path (upstream #12066):
    // it prefixes the escaped absolute root and passes --ignore-case for a
    // lowercase pattern, so the adapter must match the absolute candidate.
    const anchored = await exec(
      fd,
      [
        "--glob",
        "--color=never",
        "--hidden",
        "--no-require-git",
        "--max-results",
        "10",
        "--full-path",
        "--ignore-case",
        "--",
        `${project}/nested/*.txt`,
        project
      ],
      { cwd: project, env: f.env }
    );
    assert.equal(anchored.stdout.trim(), "nested/deep.txt");
    const content = await exec(
      rg,
      [
        "--json",
        "--line-number",
        "--color=never",
        "--hidden",
        "--fixed-strings",
        "--glob",
        "hello.txt",
        "--",
        "fixture",
        project
      ],
      { env: f.env }
    );
    const event = JSON.parse(content.stdout);
    assert.equal(event.type, "match");
    assert.equal(event.data.path.text, join(project, "hello.txt"));
    assert.equal(event.data.line_number, 1);
    const pi = await exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { createFindTool, createGrepTool } from "@earendil-works/pi-coding-agent";
      const root = process.env.FORMICAND_SEARCH_FIXTURE_PROJECT;
      const found = await createFindTool(root).execute("find-fixture", {pattern:"*.txt"});
      const anchored = await createFindTool(root).execute("find-anchored", {pattern:"nested/*.txt"});
      const searched = await createGrepTool(root).execute("grep-fixture", {pattern:"fixture",glob:"hello.txt",literal:true});
      const contextual = await createGrepTool(root).execute("grep-context", {pattern:"fixture",glob:"hello.txt",literal:true,context:1});
      console.log(JSON.stringify({found,anchored,searched,contextual}));
    `
      ],
      {
        cwd: resolve("."),
        env: { ...f.env, PI_CODING_AGENT_DIR: agent, FORMICAND_SEARCH_FIXTURE_PROJECT: project },
        timeout: 10_000
      }
    );
    const tools = JSON.parse(pi.stdout);
    assert.equal(tools.found.content[0].text, "hello.txt\nnested/deep.txt\npkg/nested/other.txt");
    assert.equal(
      tools.anchored.content[0].text,
      "nested/deep.txt",
      "Pi 1.6.1's relative path glob stays anchored at the search directory"
    );
    assert.equal(tools.searched.content[0].text, "hello.txt:1: hello fixture");
    assert.equal(
      tools.contextual.content[0].text,
      "hello.txt:1: hello fixture\nhello.txt-2- second line",
      "context rows travel through the rg adapter's --context flag"
    );
    await assert.rejects(
      exec(rg, ["--", "absent", project], { env: f.env }),
      (error) => error.code === 1 && error.stdout === ""
    );
    await assert.rejects(
      exec(fd, ["--unknown"], { env: f.env }),
      (error) => error.code === 2 && /does not support/.test(error.stderr)
    );
  }
);

test(
  "real Pi find treats glob-like characters in the project root literally",
  { skip: !portable },
  async (t) => {
    const f = await fixture(t);
    const agent = join(f.root, "agent");
    // Pi 1.6.1 prefixes the absolute search path to a relative path glob. fd
    // treats the directory name literally, so `@(dev)` must not become a
    // minimatch extglob and hide an existing file.
    const project = join(f.root, "app@(dev)");
    await f.put("app@(dev)/nested/file.txt", "fixture\n");
    await installSearchToolAdapters(agent);
    const pi = await exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { createFindTool } from "@earendil-works/pi-coding-agent";
      const found = await createFindTool(process.env.FORMICAND_SEARCH_FIXTURE_PROJECT).execute("find-literal", {pattern:"nested/*.txt"});
      console.log(JSON.stringify(found));
    `
      ],
      {
        cwd: resolve("."),
        env: { ...f.env, PI_CODING_AGENT_DIR: agent, FORMICAND_SEARCH_FIXTURE_PROJECT: project },
        timeout: 10_000
      }
    );
    const found = JSON.parse(pi.stdout);
    assert.equal(found.content[0].text, "nested/file.txt");
  }
);

test("doctor exercises offline search and reports missing or failing search modules", async (t) => {
  const f = await fixture(t);
  await f.put(
    "user/config.json",
    JSON.stringify({
      baseUrl: "https://example.invalid/v1",
      model: "fixture",
      apiKey: "fixture-key",
      workspaceRoot: join(f.root, "workspace")
    })
  );
  const healthy = await exec(process.execPath, [cli, "doctor"], { cwd: f.root, env: f.env });
  assert.match(healthy.stdout, /OK.*离线文件查找与内容搜索/);
  assert.match(healthy.stdout, /无需安装 fd 或 rg/);
  assert.match(healthy.stdout, /未发送模型请求/);
  const packageRoot = join(f.root, "broken-package");
  await mkdir(join(packageRoot, "scripts"), { recursive: true });
  await writeFile(join(packageRoot, "scripts/formicand.mjs"), await readFile(cli));
  await writeFile(
    join(packageRoot, "scripts/cli-information.mjs"),
    await readFile(resolve("scripts/cli-information.mjs"))
  );
  await writeFile(
    join(packageRoot, "scripts/data-home.cjs"),
    await readFile(resolve("scripts/data-home.cjs"))
  );
  await symlink(
    resolve("dist"),
    join(packageRoot, "dist"),
    process.platform === "win32" ? "junction" : "dir"
  );
  await symlink(
    resolve("node_modules"),
    join(packageRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir"
  );
  const brokenCli = join(packageRoot, "scripts/formicand.mjs");
  await assert.rejects(
    exec(process.execPath, [brokenCli, "doctor"], { cwd: f.root, env: f.env }),
    (error) => {
      assert.match(error.stderr, /FAIL.*离线文件查找与内容搜索/);
      assert.match(error.stdout, /OK.*模型配置/);
      return true;
    }
  );
  await writeFile(
    join(packageRoot, "scripts/file-search.mjs"),
    await readFile(resolve("scripts/file-search.mjs"))
  );
  await assert.rejects(
    exec(process.execPath, [brokenCli, "doctor"], { cwd: f.root, env: f.env }),
    (error) => {
      assert.match(error.stderr, /FAIL.*离线文件查找与内容搜索.*search-tool-adapter/);
      return true;
    }
  );
  await writeFile(
    join(packageRoot, "scripts/search-tool-adapter.mjs"),
    await readFile(resolve("scripts/search-tool-adapter.mjs"))
  );
  await writeFile(
    join(packageRoot, "scripts/file-search.mjs"),
    "export const SEARCH_ADAPTER_MARKER = '# Formicand Pi search adapter v1';\nexport async function runFileSearch() { throw new Error('fixture search failed'); }\n"
  );
  await assert.rejects(exec(process.execPath, [brokenCli, "doctor"], { cwd: f.root, env: f.env }), (error) =>
    /FAIL.*离线文件查找与内容搜索.*fixture search failed/.test(error.stderr)
  );
});

test(
  "disk search prefers real fd and rg while matching portable results",
  { skip: !portable || !nativeTools.fd || !nativeTools.rg },
  async (t) => {
    const f = await fixture(t);
    setTestPath(t, realPaths);
    await f.put(".gitignore", "ignored/\n*.tmp\n");
    await f.put(".git/marker", "ignored");
    await f.put("node_modules/not-source.ts", "Hello\n");
    await f.put("ignored/secret.ts", "Hello\n");
    await f.put(".hidden.ts", "Hello hidden\n");
    await f.put("hello.txt", "first\r\nHello [world]\r\nlast\r\nHELLO\r\n");
    await f.put("src/foo.ts", "Hello source\n");
    await f.put("src/FILE.TS", "Hello upper\n");
    await f.put("src/dir/nested.ts", "Hello nested\n");
    await f.put("binary.txt", Buffer.from("Hello\0binary"));
    await f.put("large.txt", Buffer.alloc(4 * 1024 * 1024 + 1, "a"));
    const assertFind = async (parameters) => {
      const disk = await runDiskSearch("find", parameters, { cwd: f.root });
      const node = await findFiles(parameters, f.root);
      assert.deepEqual(sortedPaths(disk), sortedPaths(node), JSON.stringify(parameters));
      assert.equal(disk.limitReached, node.limitReached);
    };
    await assertFind({ pattern: "*.ts" });
    await assertFind({ pattern: "src/*.ts" });
    await assertFind({ pattern: "src/*.TS" });
    await assertFind({ pattern: "**/*.ts" });
    await assertFind({ pattern: "*.ts", limit: 2 });
    await assertFind({ pattern: "*.ts", limit: 10 });
    assert.deepEqual(sortedPaths(await runDiskSearch("find", { pattern: "./src/*.ts" }, { cwd: f.root })), [
      "src/foo.ts"
    ]);
    // The portable backend also receives the normalized pattern, so offline
    // installs and native installs agree on Pi's leading "./" syntax.
    const restored = process.env.PATH;
    process.env.PATH = join(f.root, "missing-tools");
    assert.deepEqual(sortedPaths(await runDiskSearch("find", { pattern: "./src/*.ts" }, { cwd: f.root })), [
      "src/foo.ts"
    ]);
    process.env.PATH = restored;

    const assertGrep = async (parameters) => {
      const disk = await runDiskSearch("grep", parameters, { cwd: f.root });
      const node = await grepFiles(parameters, f.root);
      assert.deepEqual(disk, node, JSON.stringify(parameters));
    };
    await assertGrep({ pattern: "Hello [world]", literal: true, context: 1, path: "hello.txt" });
    await assertGrep({ pattern: "^hello", ignoreCase: true, glob: "hello.txt" });
    await assertGrep({ pattern: "Hello$", glob: "hello.txt" });
    await assertGrep({ pattern: "Hello", literal: false, glob: "hello.txt" });
    await assertGrep({ pattern: "Hello", literal: true, glob: "src/*.ts" });
    assert.deepEqual(
      (await runDiskSearch("grep", { pattern: "Hello", literal: true, glob: "./src/*.ts" }, { cwd: f.root }))
        .matches,
      [{ path: join(f.root, "src/foo.ts"), lineNumber: 1, line: "Hello source" }]
    );
    await assertGrep({ pattern: "Hello", literal: true, path: "hello.txt", context: 1 });
    const skipped = await runDiskSearch("grep", { pattern: "Hello", literal: true }, { cwd: f.root });
    assert.deepEqual(skipped.skippedFiles, ["large.txt"]);
    assert.equal(
      skipped.matches.some((match) => match.path.endsWith("binary.txt")),
      false,
      "binary files stay skipped like the portable backend"
    );
    await f.put("fresh.ts", "Hello fresh\n");
    assert.ok(
      (await runDiskSearch("find", { pattern: "fresh*" }, { cwd: f.root })).paths.includes("fresh.ts"),
      "a just-written file is visible immediately"
    );
  }
);

test(
  "disk search passes portable arguments to native fd and rg",
  { skip: !portable || !nativeTools.fd || !nativeTools.rg },
  async (t) => {
    const f = await fixture(t);
    await f.put("hello.txt", "Hello fixture\n");
    await f.put("src/foo.ts", "Hello source\n");
    const bin = join(f.root, "bin");
    const fdLog = join(f.root, "fd.log");
    const rgLog = join(f.root, "rg.log");
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, "fd"),
      `#!/bin/sh\nprintf '%s\\n' "$@" >> ${shellQuote(fdLog)}\nexec ${shellQuote(nativeTools.fd)} "$@"\n`,
      { mode: 0o755 }
    );
    await writeFile(
      join(bin, "rg"),
      `#!/bin/sh\nprintf '%s\\n' "$@" >> ${shellQuote(rgLog)}\nexec ${shellQuote(nativeTools.rg)} "$@"\n`,
      { mode: 0o755 }
    );
    setTestPath(t, bin);
    const found = await runDiskSearch("find", { pattern: "src/*.ts" }, { cwd: f.root });
    assert.deepEqual(found.paths, ["src/foo.ts"]);
    const searched = await runDiskSearch(
      "grep",
      { pattern: "Hello", literal: true, context: 1, glob: "hello.txt" },
      { cwd: f.root }
    );
    assert.equal(searched.matchCount, 1);
    const fdArgs = (await readFile(fdLog, "utf8")).split("\n").filter(Boolean);
    for (const flag of [
      "--glob",
      "--full-path",
      "--print0",
      "--case-sensitive",
      "--max-results",
      "--no-require-git"
    ])
      assert.ok(fdArgs.includes(flag), `fd receives ${flag}`);
    assert.ok(fdArgs.includes("--exclude"));
    const rgArgs = (await readFile(rgLog, "utf8")).split("\n").filter(Boolean);
    for (const flag of ["--files-with-matches", "--null", "--fixed-strings", "--max-filesize"])
      assert.ok(rgArgs.includes(flag), `rg receives ${flag}`);
    for (const flag of ["--json", "--crlf", "--line-number", "--context"])
      assert.equal(
        rgArgs.includes(flag),
        false,
        `rg lists candidate files and the Node matcher handles ${flag}`
      );
    assert.ok(rgArgs.includes("--glob=!.git"));
    assert.equal(
      rgArgs.includes("--glob=hello.txt"),
      false,
      "a positive glob is filtered in JavaScript instead of overriding .gitignore"
    );
    assert.ok(rgArgs.includes("--no-require-git"));
  }
);

test(
  "disk search keeps portable ignore-case literal and whitespace regex matching with native tools",
  { skip: !portable || !nativeTools.rg },
  async (t) => {
    const f = await fixture(t);
    setTestPath(t, realPaths);
    await f.put("case.txt", "s\nſ\ni\nİ\n\u0085\n\ufeff\n");
    const cases = [
      [{ pattern: "s", literal: true, ignoreCase: true }, [1]],
      [{ pattern: "i", literal: true, ignoreCase: true }, [3, 4]],
      [{ pattern: "^\\s$" }, [6]],
      [{ pattern: "^\\S$" }, [1, 2, 3, 4, 5]]
    ];
    for (const [parameters, lineNumbers] of cases) {
      const disk = await runDiskSearch("grep", parameters, { cwd: f.root });
      assert.deepEqual(disk, await grepFiles(parameters, f.root), JSON.stringify(parameters));
      assert.deepEqual(
        disk.matches.map((match) => match.lineNumber),
        lineNumbers,
        JSON.stringify(parameters)
      );
    }
  }
);

test(
  "disk search keeps carriage-return line numbers and trailing empty lines with native tools",
  { skip: !portable || !nativeTools.rg },
  async (t) => {
    const f = await fixture(t);
    setTestPath(t, realPaths);
    await f.put("lines.txt", "a\rb\rc\n");
    const cases = [
      [{ pattern: "b" }, 2],
      [{ pattern: "c" }, 3],
      [{ pattern: "b", literal: true }, 2],
      [{ pattern: "c", literal: true }, 3],
      [{ pattern: "^b$" }, 2],
      [{ pattern: "^$" }, 4]
    ];
    for (const [parameters, lineNumber] of cases) {
      const disk = await runDiskSearch("grep", parameters, { cwd: f.root });
      assert.deepEqual(disk, await grepFiles(parameters, f.root), JSON.stringify(parameters));
      assert.deepEqual(
        disk.matches.map((match) => match.lineNumber),
        [lineNumber],
        JSON.stringify(parameters)
      );
    }
  }
);

test(
  "disk search stops the oversized scan on abort and timeout when only rg is available",
  { skip: !portable || !nativeTools.rg },
  async (t) => {
    const f = await fixture(t);
    const bin = join(f.root, "rg-only-bin");
    await mkdir(bin, { recursive: true });
    await symlink(nativeTools.rg, join(bin, "rg"));
    for (let directory = 0; directory < 200; directory++) {
      const path = join(f.root, `group-${String(directory).padStart(3, "0")}`);
      await mkdir(path);
      await Promise.all(
        Array.from({ length: 50 }, (_, index) => writeFile(join(path, `file-${index}.txt`), "word\n"))
      );
    }
    setTestPath(t, bin);
    const parameters = { pattern: "word", literal: true, limit: 1 };
    const abort = new AbortController();
    const aborted = runDiskSearch("grep", parameters, { cwd: f.root, signal: abort.signal });
    const timer = setTimeout(() => abort.abort(), 80);
    try {
      await assert.rejects(aborted, /aborted/);
    } finally {
      clearTimeout(timer);
    }
    await assert.rejects(runDiskSearch("grep", parameters, { cwd: f.root, timeoutMs: 60 }), /timed out/);
    assert.deepEqual(
      await runDiskSearch("grep", parameters, { cwd: f.root, timeoutMs: 10_000 }),
      await grepFiles(parameters, f.root)
    );
  }
);

test("disk search ignores Formicand search adapters on PATH and stays on the Node backend", async (t) => {
  if (!portable) return;
  const f = await fixture(t);
  await f.put("hello.txt", "Hello fixture\n");
  await f.put("src/foo.ts", "Hello source\n");
  const bin = join(f.root, "bin");
  const fdRan = join(f.root, "fd-ran");
  const rgRan = join(f.root, "rg-ran");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "fd"),
    `#!/bin/sh\n# Formicand Pi search adapter v1\ntouch ${shellQuote(fdRan)}\nexit 9\n`,
    { mode: 0o755 }
  );
  await writeFile(
    join(bin, "rg"),
    `#!/bin/sh\n# CoworkOS Pi search adapter v1\ntouch ${shellQuote(rgRan)}\nexec missing-helper search-tool-adapter.mjs "$@"\n`,
    { mode: 0o755 }
  );
  setTestPath(t, bin);
  assert.deepEqual(
    sortedPaths(await runDiskSearch("find", { pattern: "*.ts" }, { cwd: f.root })),
    sortedPaths(await findFiles({ pattern: "*.ts" }, f.root))
  );
  assert.deepEqual(
    await runDiskSearch("grep", { pattern: "Hello", literal: true }, { cwd: f.root }),
    await grepFiles({ pattern: "Hello", literal: true }, f.root)
  );
  assert.equal(existsSync(fdRan), false, "the fd adapter is never executed as a native tool");
  assert.equal(existsSync(rgRan), false, "the rg adapter is never executed as a native tool");
});

test(
  "disk search falls back for native semantics it cannot express",
  { skip: !portable || !nativeTools.fd || !nativeTools.rg },
  async (t) => {
    const f = await fixture(t);
    setTestPath(t, realPaths);
    await f.put("hello.txt", "Hello world\n");
    await f.put("src/foo.ts", "Hello foo\n");
    await f.put("src/bar.ts", "Hello bar\n");
    await f.put("app@(dev)/nested/file.txt", "fixture\n");
    const assertFind = async (parameters, cwd = f.root) => {
      assert.deepEqual(
        sortedPaths(await runDiskSearch("find", parameters, { cwd })),
        sortedPaths(await findFiles(parameters, cwd)),
        JSON.stringify(parameters)
      );
    };
    await assertFind({ pattern: "src/@(foo|bar).ts" });
    await assertFind({ pattern: "nested/*.txt" }, join(f.root, "app@(dev)"));
    await assertFind({ pattern: join(f.root, "src/*.ts") });
    await assertFind({ pattern: "" });
    const assertGrep = async (parameters) => {
      assert.deepEqual(
        await runDiskSearch("grep", parameters, { cwd: f.root }),
        await grepFiles(parameters, f.root),
        JSON.stringify(parameters)
      );
    };
    await assertGrep({ pattern: "Hello(?= world)" });
    await assertGrep({ pattern: "Hello", literal: true, glob: "src/@(foo|bar).ts" });
    await assertGrep({ pattern: "Hello\nworld", literal: true });
    assert.deepEqual(
      await runDiskSearch("autocomplete", { pattern: "*.ts", glob: true, types: ["f"] }, { cwd: f.root }),
      await runFileSearch("autocomplete", { pattern: "*.ts", glob: true, types: ["f"] }, { cwd: f.root })
    );
  }
);

test(
  "disk search aborts and times out native tools without leaking processes",
  { skip: !portable },
  async (t) => {
    const f = await fixture(t);
    await f.put("hello.txt", "Hello fixture\n");
    const bin = join(f.root, "slow-bin");
    const pidFile = join(f.root, "slow.pid");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "fd"), `#!/bin/sh\necho $$ > ${shellQuote(pidFile)}\nexec /bin/sleep 37\n`, {
      mode: 0o755
    });
    setTestPath(t, bin);
    const waitForPid = async () => {
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          return Number(await readFile(pidFile, "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        await delay(10);
      }
      throw new Error("slow native tool did not start");
    };
    const assertGone = (pid) => {
      assert.throws(() => process.kill(pid, 0), /ESRCH|no such process/i);
    };
    const abort = new AbortController();
    const abortedSearch = runDiskSearch("find", { pattern: "*.ts" }, { cwd: f.root, signal: abort.signal });
    const abortedPid = await waitForPid();
    abort.abort();
    await assert.rejects(abortedSearch, /aborted/);
    assertGone(abortedPid);

    await rm(pidFile, { force: true });
    await assert.rejects(
      runDiskSearch("find", { pattern: "*.ts" }, { cwd: f.root, timeoutMs: 150 }),
      /timed out/
    );
    assertGone(await waitForPid());
    process.env.PATH = join(f.root, "missing-tools");
    assert.deepEqual((await runDiskSearch("find", { pattern: "*.txt" }, { cwd: f.root })).paths, [
      "hello.txt"
    ]);
  }
);

test(
  "disk search cancels the rg discovery that regex and ignore-case patterns share",
  { skip: !portable },
  async (t) => {
    const f = await fixture(t);
    await f.put("hello.txt", "Hello fixture\n");
    const bin = join(f.root, "slow-rg-bin");
    const pidFile = join(f.root, "slow-rg.pid");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "rg"), `#!/bin/sh\necho $$ > ${shellQuote(pidFile)}\nexec /bin/sleep 37\n`, {
      mode: 0o755
    });
    setTestPath(t, bin);
    const waitForPid = async () => {
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          return Number(await readFile(pidFile, "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        await delay(10);
      }
      throw new Error("slow rg discovery did not start");
    };
    const assertGone = (pid) => {
      assert.throws(() => process.kill(pid, 0), /ESRCH|no such process/i);
    };
    const abort = new AbortController();
    const aborted = runDiskSearch(
      "grep",
      { pattern: "^Hello", ignoreCase: true },
      { cwd: f.root, signal: abort.signal }
    );
    const abortedPid = await waitForPid();
    abort.abort();
    await assert.rejects(aborted, /aborted/);
    assertGone(abortedPid);
    await rm(pidFile, { force: true });
    const timed = runDiskSearch("grep", { pattern: "^Hello$" }, { cwd: f.root, timeoutMs: 500 });
    const timeoutPid = await waitForPid();
    await assert.rejects(timed, /timed out/);
    assertGone(timeoutPid);
  }
);

test(
  "disk search keeps grep context, limits, truncation and skip notices on the native path",
  { skip: !portable || !nativeTools.fd || !nativeTools.rg },
  async (t) => {
    const f = await fixture(t);
    setTestPath(t, realPaths);
    await f.put("long.txt", `${"Hello" + "x".repeat(2000)}\n`.repeat(100));
    await f.put("context.txt", "first\nHello\nlast\nHello again\n");
    await f.put("tail.txt", "Hello\n");
    await f.put("many.txt", `${"Hello\n".repeat(300)}`);
    const assertGrep = async (parameters) => {
      assert.deepEqual(
        await runDiskSearch("grep", parameters, { cwd: f.root }),
        await grepFiles(parameters, f.root),
        JSON.stringify(parameters)
      );
    };
    await assertGrep({ pattern: "Hello", literal: true, path: "long.txt" });
    await assertGrep({ pattern: "Hello", literal: true, path: "context.txt", context: 1 });
    await assertGrep({ pattern: "Hello", literal: true, path: "tail.txt", context: 1 });
    await assertGrep({ pattern: "Hello", literal: true, path: "many.txt", limit: 5 });
    await assertGrep({ pattern: "Hello", literal: true, path: "many.txt", limit: 100 });
    const limited = await runDiskSearch(
      "grep",
      { pattern: "Hello", literal: true, path: "many.txt", limit: 5 },
      { cwd: f.root }
    );
    assert.equal(limited.limitReached, true);
    const bounded = await runDiskSearch(
      "grep",
      { pattern: "Hello", literal: true, path: "long.txt" },
      { cwd: f.root }
    );
    assert.equal(bounded.outputLimitReached, true);
    assert.equal(bounded.linesTruncated, true);
    assert.ok(Buffer.byteLength(bounded.text) <= 64 * 1024);
    // Native parallel traversal orders files differently from the portable
    // depth-first walk, so compare aggregate behavior rather than one order.
    const multi = await grepFiles({ pattern: "Hello", literal: true }, f.root);
    const native = await runDiskSearch("grep", { pattern: "Hello", literal: true }, { cwd: f.root });
    assert.equal(native.matchCount, multi.matchCount);
    assert.equal(native.limitReached, multi.limitReached);
    assert.ok(Buffer.byteLength(native.text) <= 64 * 1024);
  }
);

test("disk search falls back to the portable backend when no native tools are on PATH", async (t) => {
  const f = await fixture(t);
  await f.put("hello.txt", "first\nHello\nlast\n");
  await f.put("src/foo.ts", "Hello source\n");
  await f.put("src/bar.ts", "Hello bar\n");
  setTestPath(t, join(f.root, "no-native-tools"));
  assert.deepEqual(
    sortedPaths(await runDiskSearch("find", { pattern: "./src/*.ts", limit: 1 }, { cwd: f.root })),
    ["src/bar.ts"]
  );
  assert.deepEqual(
    await runDiskSearch(
      "grep",
      { pattern: "Hello", literal: true, context: 1, glob: "hello.txt" },
      { cwd: f.root }
    ),
    await grepFiles({ pattern: "Hello", literal: true, context: 1, glob: "hello.txt" }, f.root)
  );
  await assert.rejects(runDiskSearch("grep", { pattern: "[" }, { cwd: f.root }), /regular expression/);
  await assert.rejects(
    runDiskSearch("find", { pattern: "*", path: "missing" }, { cwd: f.root }),
    /Path not found/
  );
});

test(
  "disk search keeps a positive glob inside .gitignore on the native path",
  { skip: !portable || !nativeTools.rg },
  async (t) => {
    const f = await fixture(t);
    setTestPath(t, realPaths);
    await f.put(".gitignore", "ignored.txt\nsaved.txt\n");
    await f.put("ignored.txt", "Hello ignored\n");
    await f.put("saved.txt", "Hello saved\n");
    await f.put("kept.txt", "Hello kept\n");
    const parameters = { pattern: "Hello", literal: true, glob: "*.txt" };
    assert.deepEqual(
      await runDiskSearch("grep", parameters, { cwd: f.root }),
      await grepFiles(parameters, f.root)
    );
  }
);

test(
  "disk search keeps rg-only ignore files in scope for every pattern",
  { skip: !portable || !nativeTools.rg },
  async (t) => {
    const f = await fixture(t);
    await exec("git", ["init", "-b", "main", f.root]);
    await f.put(".git/info/exclude", "local.txt\n");
    await f.put(".rgignore", "generated.txt\n");
    await f.put(".gitignore", "*.log\n!keep.log\nnested/\n");
    await f.put(".ignore", "private.txt\n");
    for (const path of [
      "included.txt",
      "local.txt",
      "generated.txt",
      "dropped.log",
      "keep.log",
      "private.txt",
      "nested/hidden.txt",
      "deep/kept.txt"
    ])
      await f.put(path, "uniquemarker\n");
    const scope = async (parameters) =>
      (await runDiskSearch("grep", parameters, { cwd: f.root })).matches
        .map((match) => match.path.slice(f.root.length + 1))
        .sort();
    setTestPath(t, realPaths);
    // Regex and ignore-case patterns ask rg for the files in scope; they must
    // not widen it to files .git/info/exclude or .rgignore keep out.
    const expected = ["deep/kept.txt", "included.txt", "keep.log"];
    for (const parameters of [
      { pattern: "^uniquemarker$" },
      { pattern: "UNIQUEMARKER", literal: true, ignoreCase: true },
      { pattern: "uniquemarker", literal: true }
    ])
      assert.deepEqual(await scope(parameters), expected, JSON.stringify(parameters));
    assert.deepEqual(await scope({ pattern: "UNIQUEMARKER", literal: true }), []);
    // Offline installs keep the portable scope: .gitignore/.ignore with
    // negation and no knowledge of rg's additional ignore files.
    setTestPath(t, join(f.root, "missing-tools"));
    assert.deepEqual(await scope({ pattern: "^uniquemarker$" }), [
      "deep/kept.txt",
      "generated.txt",
      "included.txt",
      "keep.log",
      "local.txt"
    ]);
  }
);

test(
  "disk search falls back for JavaScript regex word and digit semantics",
  { skip: !portable || !nativeTools.rg },
  async (t) => {
    const f = await fixture(t);
    setTestPath(t, realPaths);
    await f.put("unicode.txt", "café\n١٢٣\né\n");
    for (const pattern of ["^\\w+$", "^\\d+$", "\\bé", "\\W", "\\D", "\\B"])
      assert.deepEqual(
        await runDiskSearch("grep", { pattern }, { cwd: f.root }),
        await grepFiles({ pattern }, f.root),
        pattern
      );
  }
);

test(
  "disk search keeps file names containing newlines on the native fd paths",
  { skip: !portable || !nativeTools.fd },
  async (t) => {
    const f = await fixture(t);
    setTestPath(t, realPaths);
    await f.put("line\nbreak.txt", "Hello\n");
    await f.put("plain.txt", "Hello\n");
    const parameters = { pattern: "*.txt" };
    const disk = await runDiskSearch("find", parameters, { cwd: f.root });
    const node = await findFiles(parameters, f.root);
    assert.deepEqual(sortedPaths(disk), sortedPaths(node));
    assert.equal(disk.limitReached, node.limitReached);
    await f.put("large\nline.txt", Buffer.alloc(4 * 1024 * 1024 + 1, "a"));
    const skipped = await runDiskSearch(
      "grep",
      { pattern: "Hello", literal: true, glob: "*.txt" },
      { cwd: f.root }
    );
    assert.deepEqual(skipped.skippedFiles, ["large\nline.txt"]);
  }
);

test(
  "disk search stops native tools that ignore SIGTERM on abort and timeout",
  { skip: !portable },
  async (t) => {
    const f = await fixture(t);
    const bin = join(f.root, "stubborn-bin");
    const pidRoot = await mkdtemp(join(tmpdir(), "formicand-stubborn-"));
    const pidFile = join(pidRoot, "stubborn.pid");
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, "fd"),
      `#!/bin/sh\ntrap '' TERM\necho $$ > ${shellQuote(pidFile)}\ncase " $* " in\n  *" --print0 "*) printf '%s\\0' ${shellQuote(join(f.root, "first.txt"))} ${shellQuote(join(f.root, "second.txt"))} ;;\n  *) printf '%s\\n' ${shellQuote(join(f.root, "first.txt"))} ${shellQuote(join(f.root, "second.txt"))} ;;\nesac\nwhile :; do sleep 1; done\n`,
      { mode: 0o755 }
    );
    setTestPath(t, bin);
    const readPid = async () => {
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          const pid = Number(await readFile(pidFile, "utf8"));
          if (Number.isInteger(pid) && pid > 0) return pid;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        await delay(10);
      }
      throw new Error("stubborn native tool did not start");
    };
    t.after(async () => {
      try {
        const pid = Number(await readFile(pidFile, "utf8"));
        if (!Number.isInteger(pid) || pid <= 0) return;
        try {
          process.kill(-pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // The child already exited; nothing to clean up.
            }
          }
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      } finally {
        await rm(pidRoot, { recursive: true, force: true });
      }
    });
    const assertGone = (pid) => {
      assert.throws(() => process.kill(pid, 0), /ESRCH|no such process/i);
    };
    const outcome = async (search) => {
      const started = Date.now();
      try {
        return { result: await search, elapsed: Date.now() - started };
      } catch (error) {
        return { error, elapsed: Date.now() - started };
      }
    };
    const guard = (label) => {
      let timer;
      const promise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} native child survived SIGTERM`)), 8000);
      });
      return { promise, cancel: () => clearTimeout(timer) };
    };

    const abort = new AbortController();
    const aborted = runDiskSearch("find", { pattern: "*.txt" }, { cwd: f.root, signal: abort.signal });
    const abortedPid = await readPid();
    abort.abort();
    const abortGuard = guard("aborted");
    const abortOutcome = await Promise.race([outcome(aborted), abortGuard.promise]);
    abortGuard.cancel();
    assert.match(String(abortOutcome.error?.message), /aborted/);
    assert.ok(abortOutcome.elapsed >= 1800, `abort waited ${abortOutcome.elapsed}ms for SIGKILL`);
    assertGone(abortedPid);
    await rm(pidFile, { force: true });

    const timeoutGuard = guard("timed out");
    const timeoutOutcome = await Promise.race([
      outcome(runDiskSearch("find", { pattern: "*.txt" }, { cwd: f.root, timeoutMs: 100 })),
      timeoutGuard.promise
    ]);
    timeoutGuard.cancel();
    assert.match(String(timeoutOutcome.error?.message), /timed out/);
    assert.ok(timeoutOutcome.elapsed >= 1800, `timeout waited ${timeoutOutcome.elapsed}ms for SIGKILL`);
    assertGone(await readPid());
    await rm(pidFile, { force: true });

    const limitGuard = guard("limit-stopped");
    const limitOutcome = await Promise.race([
      outcome(runDiskSearch("find", { pattern: "*.txt", limit: 1 }, { cwd: f.root, timeoutMs: 10_000 })),
      limitGuard.promise
    ]);
    limitGuard.cancel();
    assert.equal(limitOutcome.error, undefined);
    assert.equal(limitOutcome.result.limitReached, true);
    assert.ok(limitOutcome.elapsed >= 1800, `limit stop waited ${limitOutcome.elapsed}ms for SIGKILL`);
    assertGone(await readPid());
    await rm(pidFile, { force: true });
  }
);

test(
  "disk search reports an fd skip-scan failure instead of an empty skip list",
  { skip: !portable || process.getuid?.() === 0 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "formicand-file-search-"));
    const bin = join(root, "scan-failure-bin");
    const locked = join(root, "locked");
    await mkdir(bin, { recursive: true });
    await mkdir(locked);
    await writeFile(join(locked, "inside.txt"), "Hello\n");
    await writeFile(
      join(bin, "fd"),
      `#!/bin/sh\nprintf '%s\\0' ${shellQuote(join(locked, "inside.txt"))}\n`,
      { mode: 0o755 }
    );
    await writeFile(join(bin, "rg"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    setTestPath(t, bin);
    t.after(async () => {
      await chmod(locked, 0o755).catch(() => {});
      await rm(root, { recursive: true, force: true });
    });
    await chmod(locked, 0o000);
    await assert.rejects(runDiskSearch("grep", { pattern: "Hello", literal: true }, { cwd: root }), (error) =>
      /EACCES|permission denied/i.test(String(error.message))
    );
  }
);
