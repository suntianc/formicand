import { execFile } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
import { cpus, freemem, homedir, platform, totalmem } from "node:os";
import { promisify } from "node:util";

/**
 * How busy this machine is, for its card in Settings → Nodes: CPU, memory and
 * the disk that holds the user's home, each as a used percentage, and the
 * operating system the card's mark is drawn from.
 */
export interface NodeResources {
  /** `macos`, `windows`, or the Linux distribution's `ID` (`ubuntu`, `debian`, …). */
  system: string;
  cpu: number;
  memory: number;
  disk: number;
  memoryBytes: number;
  diskBytes: number;
}

const run = promisify(execFile);
const percent = (used: number, total: number) => (total > 0 ? Math.round((used / total) * 100) : 0);

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const core of cpus()) {
    const { user, nice, sys, irq, idle: rest } = core.times;
    idle += rest;
    total += user + nice + sys + irq + rest;
  }
  return { idle, total };
}

async function system(): Promise<string> {
  const name = platform();
  if (name === "darwin") return "macos";
  if (name === "win32") return "windows";
  if (name !== "linux") return name;
  try {
    const release = await readFile("/etc/os-release", "utf8");
    return /^ID="?([\w.-]+)"?$/m.exec(release)?.[1]?.toLowerCase() ?? "linux";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "linux";
    throw error;
  }
}

/** Memory in use: what the system could not hand to a new program without swapping. */
async function memoryUsed(): Promise<number> {
  const total = totalmem();
  if (platform() === "linux") {
    const info = await readFile("/proc/meminfo", "utf8");
    const available = Number(/^MemAvailable:\s+(\d+)/m.exec(info)?.[1] ?? Number.NaN) * 1024;
    if (Number.isFinite(available)) return total - available;
  }
  if (platform() === "darwin") {
    // `os.freemem` leaves out macOS's reclaimable cache; vm_stat counts it.
    const { stdout } = await run("vm_stat", [], { timeout: 2_000 });
    const page = Number(/page size of (\d+)/.exec(stdout)?.[1] ?? 4096);
    const pages = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(stdout)?.[1] ?? 0);
    const available =
      (pages("Pages free") +
        pages("Pages inactive") +
        pages("Pages speculative") +
        pages("Pages purgeable")) *
      page;
    return Math.max(0, total - available);
  }
  return total - freemem();
}

export function createNodeResources(): { read(): Promise<NodeResources> } {
  let previous = cpuTimes();
  let previousAt = Date.now();
  let name: Promise<string> | undefined;
  return {
    async read() {
      // CPU is the busy share since the last read, measured over at least a quarter second.
      const wait = 250 - (Date.now() - previousAt);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      const now = cpuTimes();
      const busy = now.total - previous.total - (now.idle - previous.idle);
      const cpu = percent(busy, now.total - previous.total);
      previous = now;
      previousAt = Date.now();
      const disk = await statfs(homedir());
      const diskTotal = disk.blocks * disk.bsize;
      name ??= system();
      return {
        system: await name,
        cpu,
        memory: percent(await memoryUsed(), totalmem()),
        disk: percent(diskTotal - disk.bavail * disk.bsize, diskTotal),
        memoryBytes: totalmem(),
        diskBytes: diskTotal
      };
    }
  };
}
