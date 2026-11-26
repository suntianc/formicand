import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { lookupRequirements } from "../dist/src/domain/ledger-lookup.js";
import { requirementContext } from "../dist/src/dashboard/requirement-context.js";
import { ProjectDataRuntime } from "../dist/src/workspace/project-data-service.js";

/**
 * Finding a feature by the user's own words, reading one feature's context,
 * and learning the words as an alias when lookup would have missed them.
 */

const feature = (requirementId, title, summary, extra = {}) => ({
  requirementId,
  kind: "feature",
  status: "active",
  title,
  description: "",
  aliases: [],
  summary,
  history: [],
  ...extra
});

const ledger = [
  feature("r_list", "列表显示", "list 每行是编号和标题，行末附加信息写成 [字段名 值]。"),
  feature("r_export", "导出给财务的 CSV", "export 输出 CSV，给财务用，列只能往后加。"),
  feature("r_created", "创建日期", "add 时记下创建日期，list 行末显示 [created 日期]。"),
  feature("r_remind", "到期提醒", "不做系统通知。", { status: "retired" }),
  { ...feature("r_misc", "杂项", ""), kind: "misc" }
];

test("lookup says how sure it is, and lists the catalog when it is not", () => {
  const likely = lookupRequirements(ledger, "export 导出的 CSV 再加一列");
  assert.equal(likely.verdict, "likely");
  assert.equal(likely.candidates[0].requirementId, "r_export");
  assert.ok(likely.candidates[0].matched.includes("csv"));
  // A small ledger still comes with its catalog, so a better match under
  // another name can be seen.
  assert.equal(likely.catalog.length, ledger.length);

  // Words the ledger never uses: nothing fits, and the catalog is the fallback.
  const none = lookupRequirements(ledger, "添加时间");
  assert.equal(none.verdict, "none");
  assert.deepEqual(none.candidates, []);
  assert.deepEqual(
    none.catalog.map((entry) => [entry.requirementId, entry.status]),
    ledger.map((entry) => [entry.requirementId, entry.status])
  );

  // Two features share the request's words about equally.
  const twins = [
    ...ledger,
    feature("r_columns", "CSV 的列", "export 的列：id,title,done；表头固定在第一行。")
  ];
  const several = lookupRequirements(twins, "export 的 CSV 加一列");
  assert.equal(several.verdict, "several");
  assert.deepEqual(
    several.candidates
      .map((candidate) => candidate.requirementId)
      .slice(0, 2)
      .sort(),
    ["r_columns", "r_export"]
  );

  // A retired feature is never a candidate, even by its exact title.
  assert.equal(lookupRequirements(ledger, "到期提醒").verdict, "none");
});

test("an English word next to Chinese is still a word", () => {
  const only = [feature("r_csv", "CSV", ""), { ...feature("r_misc", "杂项", ""), kind: "misc" }];
  for (const words of ["CSV导出", "CSV 导出", "导出CSV"]) {
    const found = lookupRequirements(only, words);
    assert.equal(found.candidates[0]?.requirementId, "r_csv", words);
    assert.ok(found.candidates[0].matched.includes("csv"), words);
  }
});

test("a large ledger leaves out the catalog only when one feature is likely", () => {
  const many = Array.from({ length: 31 }, (_, index) =>
    feature(`r_${index}`, `功能${index}号`, `第${index}个功能。`)
  );
  many.push(feature("r_export", "导出给财务的 CSV", "export 输出 CSV。"));
  const likely = lookupRequirements(many, "导出 CSV");
  assert.equal(likely.verdict, "likely");
  assert.equal(likely.catalog, undefined);
  assert.equal(lookupRequirements(many, "添加时间").catalog.length, many.length);
  // The catalog tells features apart by title and description, not by their rules.
  const described = lookupRequirements(
    [feature("r", "导出", "列只能往后加。", { description: "把条目导出成 CSV。" })],
    "无关"
  );
  assert.deepEqual(described.catalog[0], {
    requirementId: "r",
    kind: "feature",
    status: "active",
    title: "导出",
    aliases: [],
    description: "把条目导出成 CSV。"
  });
});

async function openLedger(t) {
  const root = await mkdtemp(join(tmpdir(), "formicand-lookup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = new ProjectDataRuntime({
    config: { sqlite: { path: join(root, "project-data.sqlite") } },
    env: {},
    configPath: join(root, "config.json"),
    dataRoot: root
  });
  t.after(() => runtime.close());
  const service = await runtime.service();
  const project = await service.ensureProject({
    projectId: "project_lookup",
    projectName: "待办",
    projectDirectory: root,
    backendId: "backend_local"
  });
  return { service, projectId: project.projectId, root };
}

const develop = (service, projectId, requirementId, request) =>
  service.createDevelopment(projectId, {
    requirementId,
    request,
    goal: "做这次改动",
    completionCriteria: ["测试通过"],
    route: "full",
    baseline: { branch: "main", commit: "0".repeat(40) }
  });

test("a development keeps the user's words as an alias only when lookup would miss them", async (t) => {
  const { service, projectId } = await openLedger(t);
  const created = await service.createRequirement(projectId, {
    title: "创建日期",
    summary: "add 时记下创建日期。"
  });
  await service.createRequirement(projectId, { title: "导出给财务的 CSV", summary: "export 输出 CSV。" });
  const exported = (await service.queryRequirements(projectId, { text: "导出" }))[0];

  // Found with confidence by these words: nothing to learn.
  const first = await develop(service, projectId, exported.requirementId, "导出 CSV");
  assert.deepEqual((await service.getRequirement(projectId, exported.requirementId)).aliases, []);
  await service.updateDevelopment(projectId, first.developmentId, {
    expectedRevision: first.revision,
    status: "withdrawn"
  });

  // Words lookup does not tie to this feature become its alias, naming the development.
  assert.equal((await service.lookupRequirements(projectId, "添加时间")).verdict, "none");
  const second = await develop(service, projectId, created.requirementId, "添加时间");
  const aliases = (await service.getRequirement(projectId, created.requirementId)).aliases;
  assert.deepEqual(
    aliases.map((alias) => [alias.alias, alias.developmentId]),
    [["添加时间", second.developmentId]]
  );
  // The next time the same words find it.
  const again = await service.lookupRequirements(projectId, "添加时间");
  assert.equal(again.verdict, "likely");
  assert.equal(again.candidates[0].requirementId, created.requirementId);

  // A development without the user's words learns nothing; too long words are refused.
  await service.updateDevelopment(projectId, second.developmentId, {
    expectedRevision: second.revision,
    status: "withdrawn"
  });
  await assert.rejects(develop(service, projectId, created.requirementId, "字".repeat(101)), {
    code: "invalid_project_data"
  });
  await develop(service, projectId, created.requirementId, undefined);
  assert.equal((await service.getRequirement(projectId, created.requirementId)).aliases.length, 1);
});

const run = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("context names the feature's decisions, developments and where its code changed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "formicand-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  run(root, "init", "-q", "-b", "main");
  run(root, "config", "user.email", "test@example.com");
  run(root, "config", "user.name", "test");
  await mkdir(join(root, "docs/adr"), { recursive: true });
  await writeFile(join(root, "docs/adr/0002-dates.md"), "日期写成 YYYY-MM-DD。\n");
  await writeFile(join(root, "README.md"), "待办\n");
  run(root, "add", ".");
  run(root, "commit", "-qm", "base");
  const baseline = run(root, "rev-parse", "HEAD");
  await mkdir(join(root, "src/commands"), { recursive: true });
  await writeFile(join(root, "src/commands/add.js"), "export {}\n");
  await writeFile(join(root, "src/commands/list.js"), "export {}\n");
  await writeFile(join(root, "src/store.js"), "export {}\n");
  run(root, "add", ".");
  run(root, "commit", "-qm", "created date");
  const candidate = run(root, "rev-parse", "HEAD");

  const history = Array.from({ length: 12 }, (_, index) => ({
    entryId: `h${index}`,
    day: `2026-01-${String(index + 1).padStart(2, "0")}`,
    text:
      index === 11
        ? "日期格式见 docs/adr/0002-dates.md。旧写法 docs/adr/0001-old.md 已撤。"
        : `第 ${index} 次`,
    createdAt: "2026-01-01T00:00:00.000Z"
  }));
  const development = (developmentId, createdAt, status, goal) => ({
    developmentId,
    requirementId: "r_created",
    status,
    goal,
    completionCriteria: ["list 显示创建日期"],
    baseline: { branch: "main", commit: baseline },
    createdAt
  });
  const service = {
    getRequirement: async () => ({
      requirementId: "r_created",
      kind: "feature",
      status: "active",
      title: "创建日期",
      revision: 3,
      summary: "add 时记下创建日期。",
      aliases: [{ alias: "添加时间", developmentId: "d1", createdAt: "2026-01-01T00:00:00.000Z" }],
      history
    }),
    queryDevelopments: async () => [
      development("d1", "2026-01-01T00:00:00.000Z", "merged", "首次交付"),
      development("d2", "2026-02-01T00:00:00.000Z", "active", "长".repeat(600)),
      { ...development("d_other", "2026-03-01T00:00:00.000Z", "active", "别的"), requirementId: "r_x" }
    ],
    queryDeliveries: async () => [
      {
        developmentId: "d1",
        requirementId: "r_created",
        candidateCommit: candidate,
        mergedCommit: candidate,
        mergedAt: "2026-01-02T00:00:00.000Z"
      }
    ]
  };

  const context = await requirementContext(service, "project_lookup", root, "r_created");
  assert.equal(context.requirement.summary, "add 时记下创建日期。");
  assert.deepEqual(
    context.requirement.aliases.map((alias) => alias.alias),
    ["添加时间"]
  );
  assert.equal(context.historyTotal, 12);
  assert.deepEqual(
    context.history.map((entry) => entry.entryId),
    history.slice(-10).map((entry) => entry.entryId)
  );
  assert.deepEqual(
    context.developments.map((item) => [item.developmentId, item.merged?.commit]),
    [
      ["d2", undefined],
      ["d1", candidate]
    ]
  );
  assert.match(context.developments[0].goal, /共 600 字/);
  assert.deepEqual(context.decisions, [
    { path: "docs/adr/0002-dates.md", present: true },
    { path: "docs/adr/0001-old.md", present: false }
  ]);
  assert.deepEqual(context.directories, [
    { directory: "src/commands", files: 2 },
    { directory: "src", files: 1 }
  ]);

  // Without a local checkout, presence and code locations are unknown, not false.
  const remote = await requirementContext(service, "project_lookup", "", "r_created");
  assert.deepEqual(remote.decisions, [{ path: "docs/adr/0002-dates.md" }, { path: "docs/adr/0001-old.md" }]);
  assert.equal(remote.directories, undefined);
});
