const { spawn } = require("node:child_process");
const { existsSync, renameSync, writeFileSync } = require("node:fs");

const role = process.argv[2];
function launch(role) {
  return spawn(process.execPath, [__filename, role], {
    stdio: "ignore",
    windowsHide: true,
    // Node normally terminates attached children when their Windows parent exits.
    detached: role === "leaf"
  });
}
function publish(name, data) {
  writeFileSync(name + ".tmp", JSON.stringify(data));
  renameSync(name + ".tmp", name);
}
if (role === "middle") {
  launch("leaf").unref();
} else {
  if (role === "outer") {
    const middle = launch("middle");
    middle.once("exit", (code) => publish("middle-exit", { pid: middle.pid, code }));
  } else {
    publish("leaf", { pid: process.pid, parent: process.ppid });
  }
  // A removed sentinel or an interrupted test ends every long-lived fixture process.
  const deadline = Date.now() + 60_000;
  const timer = setInterval(() => {
    if (!existsSync("keep-running") || Date.now() >= deadline) {
      clearInterval(timer);
    } else if (role === "leaf" && existsSync("challenge") && !existsSync("reply")) {
      publish("reply", { pid: process.pid });
    }
  }, 30);
}
