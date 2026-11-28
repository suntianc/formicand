import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const api = `
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.Win32.SafeHandles;

public static class FormicandJob {
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public long ProcessTime, JobTime;
        public uint LimitFlags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Accounting {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }

    [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle OpenJobObject(uint access, bool inherit, string name);
    [DllImport("kernel32", SetLastError = true)]
    static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
    [DllImport("kernel32", SetLastError = true)]
    static extern bool IsProcessInJob(IntPtr process, SafeFileHandle job, out bool member);
    [DllImport("kernel32", SetLastError = true)]
    static extern bool DuplicateHandle(IntPtr sourceProcess, SafeFileHandle job, IntPtr destinationProcess,
        out IntPtr destinationHandle, uint access, bool inherit, uint options);
    [DllImport("kernel32", SetLastError = true)]
    static extern bool SetInformationJobObject(SafeFileHandle job, int kind, ref ExtendedLimits limits, int size);
    [DllImport("kernel32", SetLastError = true)]
    static extern bool QueryInformationJobObject(SafeFileHandle job, int kind, out Accounting facts, int size, IntPtr length);
    [DllImport("kernel32", SetLastError = true)]
    static extern bool TerminateJobObject(SafeFileHandle job, uint code);

    static void Check(bool success) {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    public static void Bind(string name, int pid) {
        using (var self = Process.GetCurrentProcess())
        using (var worker = Process.GetProcessById(pid))
        using (var job = CreateJobObject(IntPtr.Zero, name)) {
            int error = Marshal.GetLastWin32Error();
            if (job.IsInvalid || error == 183) throw new Win32Exception(error);
            // This helper was spawned by the worker. A newer process cannot be its parent.
            IntPtr process = worker.Handle;
            if (worker.StartTime.ToUniversalTime() >= self.StartTime.ToUniversalTime()) throw new InvalidOperationException("Windows job worker identity changed");
            var limits = new ExtendedLimits { LimitFlags = 0x2000 }; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))));
            IntPtr workerJob;
            // The worker keeps the last non-inheritable handle until its exit. The launching Agent may exit first.
            Check(DuplicateHandle(self.Handle, job, process, out workerJob, 0, false, 0));
            Check(AssignProcessToJobObject(job, process));
        }
    }

    static uint Active(SafeFileHandle job) {
        Accounting facts;
        Check(QueryInformationJobObject(job, 1, out facts, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        return facts.ActiveProcesses;
    }

    static Process Find(int pid) {
        try { return Process.GetProcessById(pid); }
        catch (ArgumentException) { return null; }
    }

    public static bool Stop(string name, int pid, long launchMs, long recordedMs) {
        using (var worker = Find(pid)) {
            IntPtr process = IntPtr.Zero;
            if (worker != null && !worker.HasExited) {
                try {
                    IntPtr handle = worker.Handle;
                    long birth = new DateTimeOffset(worker.StartTime).ToUnixTimeMilliseconds();
                    if (birth < launchMs || birth > recordedMs)
                        throw new ArgumentException("The PID does not belong to the recorded job");
                    process = handle;
                } catch (InvalidOperationException) {
                    if (!worker.HasExited) throw;
                }
            }
            var deadline = Stopwatch.StartNew();
            while (deadline.ElapsedMilliseconds < 10000) {
                using (var job = OpenJobObject(0x0004 | 0x0008, false, name)) { // QUERY | TERMINATE
                    int error = Marshal.GetLastWin32Error();
                    if (job.IsInvalid) {
                        if (error != 2) throw new Win32Exception(error);
                        if (worker == null || worker.HasExited) return false;
                    } else {
                        uint active = Active(job);
                        if (active == 0 && (worker == null || worker.HasExited)) return false;
                        if (process != IntPtr.Zero) {
                            bool belongs;
                            Check(IsProcessInJob(process, job, out belongs));
                            if (belongs) {
                                Check(TerminateJobObject(job, 1));
                                while (Active(job) != 0) {
                                    if (deadline.ElapsedMilliseconds >= 10000)
                                        throw new TimeoutException("Windows job members are still running");
                                    Thread.Sleep(20);
                                }
                                return true;
                            }
                            if (active != 0)
                                throw new InvalidOperationException("The PID does not belong to the recorded Windows job");
                        }
                    }
                }
                // A stop can arrive while the worker is registering. Never kill an unverified group.
                Thread.Sleep(20);
            }
            throw new InvalidOperationException("Unable to verify the recorded Windows job");
        }
    }
}
`;

export function isWindowsJobId(value: unknown): value is string {
  return typeof value === "string" && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
}

async function operate(jobId: string, pid: number, operation: string): Promise<string> {
  if (!isWindowsJobId(jobId) || !Number.isSafeInteger(pid) || pid <= 0)
    throw new Error("Invalid Windows job identity");
  const root = process.env.SystemRoot;
  if (!root) throw new Error("SystemRoot is required to manage a Windows job");
  const script = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${api}\n'@\n${operation}`;
  try {
    const { stdout } = await run(
      join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, env: { ...process.env, FORMICAND_WIN_JOB_NAME: `Local\\Formicand-job-${jobId}` } }
    );
    return stdout.trim();
  } catch (error) {
    if (
      error instanceof Error &&
      "stderr" in error &&
      typeof error.stderr === "string" &&
      error.stderr.trim()
    )
      throw new Error(error.stderr.trim(), { cause: error });
    throw error;
  }
}

/** Assign the worker before it can spawn the shell or any of the shell's descendants. */
export async function bindWindowsJob(jobId: string): Promise<void> {
  await operate(jobId, process.pid, `[FormicandJob]::Bind($env:FORMICAND_WIN_JOB_NAME, ${process.pid})`);
}

export async function stopWindowsJob(
  jobId: string,
  pid: number,
  launchMs: number,
  recordedMs: number
): Promise<"terminated" | "absent"> {
  if (!Number.isFinite(launchMs) || !Number.isFinite(recordedMs))
    throw new Error("Invalid Windows job identity");
  const result = await operate(
    jobId,
    pid,
    `if ([FormicandJob]::Stop($env:FORMICAND_WIN_JOB_NAME, ${pid}, ${launchMs}, ${Math.ceil(recordedMs)})) { 'terminated' } else { 'absent' }`
  );
  if (result !== "terminated" && result !== "absent")
    throw new Error("Windows job stop outcome was not reported");
  return result;
}
