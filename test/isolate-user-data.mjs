import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Loaded before each test worker: changing defaults must never read or write a real user's home.
// FORMICAND_PYTHON (the explicit interpreter for document fixtures) and FORMICAND_TEST_ENGINES (which storage
// engines run) choose how tests run; neither is user data.
const home = mkdtempSync(join(tmpdir(), "formicand-test-home-"));
for (const key of Object.keys(process.env))
  if (
    /^(?:FORMICAND_|FORMICAND_|PI_)/.test(key) &&
    !["FORMICAND_TEST_CLI_ENTRY", "FORMICAND_PYTHON", "FORMICAND_TEST_ENGINES"].includes(key)
  )
    delete process.env[key];
process.env.FORMICAND_HOME = home;
process.env.FORMICAND_CONFIG = join(home, "config.json");
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
writeFileSync(process.env.FORMICAND_CONFIG, "{}\n", { mode: 0o600 });
process.once("exit", () => rmSync(home, { recursive: true, force: true }));
