import assert from "node:assert/strict";
import { test } from "node:test";
import { executorReportText, parseExecutorReport } from "../dist/src/runtime/executor-report.js";
import { processKillRefusal } from "../dist/src/tools/process-kill.js";

test("killing by name is refused, stopping a started PID is not", () => {
  const refused = (command) => processKillRefusal("bash", { command })?.path;
  assert.equal(refused("pkill -f node"), "pkill");
  assert.equal(refused("npm test; killall Electron"), "killall");
  assert.equal(refused("sudo pkill node"), "pkill");
  assert.equal(refused("pgrep -f dashboard | xargs kill -9"), "pgrep");
  assert.equal(refused("kill $(pgrep node)"), "pgrep");
  assert.equal(refused("kill `pidof node`"), "pidof");
  assert.equal(refused("kill $SERVER_PID"), undefined);
  assert.equal(refused("kill 4242 && wait 4242"), undefined);
  assert.equal(refused("grep -n pkill docs/notes.md"), undefined, "a word in an argument is not a call");
  assert.equal(processKillRefusal("read", { path: "pkill" }), undefined);
});

test("a ticket report answers every criterion exactly once, with evidence", () => {
  const ids = ["AC1", "AC2"];
  const ok = parseExecutorReport(
    {
      criteria: [
        { criterionId: "AC1", met: true, evidence: "npm test: 3 passed" },
        { criterionId: "AC2", met: false, evidence: "not reachable from the CLI" }
      ]
    },
    ids
  );
  assert.equal(ok.ok, true);
  assert.equal(
    executorReportText(ok.report),
    "Acceptance criteria, as the Executor reported them:\n- AC1 met: npm test: 3 passed\n- AC2 NOT met: not reachable from the CLI"
  );
  const errors = (value) => {
    const parsed = parseExecutorReport(value, ids);
    return parsed.ok ? [] : parsed.errors.join("\n");
  };
  assert.match(errors({ criteria: [{ criterionId: "AC1", met: true, evidence: "x" }] }), /missing AC2/);
  assert.match(errors({ criteria: [{ criterionId: "AC9", met: true, evidence: "x" }] }), /one of AC1, AC2/);
  assert.match(
    errors({
      criteria: [
        { criterionId: "AC1", met: true, evidence: "x" },
        { criterionId: "AC1", met: true, evidence: "y" },
        { criterionId: "AC2", met: true, evidence: "z" }
      ]
    }),
    /AC1 is reported twice/
  );
  assert.match(
    errors({ criteria: [{ criterionId: "AC1", met: "yes", evidence: "" }] }),
    /met must be[^]*evidence must be/
  );
  assert.match(errors([]), /object with criteria/);
});
