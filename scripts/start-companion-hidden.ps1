<#
Hidden process launcher for the iCUE Spotify companion.
Invoked only by the explicitly installed -InstallHidden scheduled task.
The PowerShell host is launched with -WindowStyle Hidden by Task Scheduler;
the child is created without a console and supervised in a Windows job.
Closing the supervisor terminates its job, preventing orphaned companions.
Never print OAuth credentials, pairing keys, or token file contents.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Node,
    [Parameter(Mandatory = $true)][string]$Entry
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) {
    throw 'Node executable not found for hidden companion.'
}
if (-not (Test-Path -LiteralPath $Entry -PathType Leaf)) {
    throw 'Companion entrypoint not found for hidden companion.'
}
$WorkingDirectory = Split-Path -Parent (Split-Path -Parent $Entry)
# The job handle belongs only to this supervisor. Windows closes it even when
# Task Scheduler terminates PowerShell, so the child cannot outlive the task.
# Start suspended and assign before resuming: no unowned running-child gap.
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class CompanionHiddenProcess {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo {
        public uint Size;
        public string Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public ushort Show, ReservedSize;
        public IntPtr ReservedData, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string app, StringBuilder command, IntPtr processSecurity,
        IntPtr threadSecurity, bool inheritHandles, uint flags, IntPtr environment,
        string directory, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    public static int Run(string node, string entry, string directory) {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        Check(job != IntPtr.Zero);
        ProcessInfo child = new ProcessInfo();
        try {
            ExtendedLimits limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))));
            StartupInfo startup = new StartupInfo();
            startup.Size = (uint)Marshal.SizeOf(typeof(StartupInfo));
            // CREATE_NO_WINDOW | CREATE_SUSPENDED; assign to job before running.
            Check(CreateProcess(node, new StringBuilder("\"" + node + "\" \"" + entry + "\""),
                IntPtr.Zero, IntPtr.Zero, false, 0x08000004, IntPtr.Zero, directory, ref startup, out child));
            if (!AssignProcessToJobObject(job, child.Process)) {
                int error = Marshal.GetLastWin32Error();
                TerminateProcess(child.Process, 1);
                throw new Win32Exception(error);
            }
            Check(ResumeThread(child.Thread) != 0xffffffff);
            Check(WaitForSingleObject(child.Process, 0xffffffff) == 0);
            uint code;
            Check(GetExitCodeProcess(child.Process, out code));
            return unchecked((int)code);
        } finally {
            CloseHandle(job);
            if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
            if (child.Process != IntPtr.Zero) CloseHandle(child.Process);
        }
    }
}
"@
exit [CompanionHiddenProcess]::Run($Node, $Entry, $WorkingDirectory)
