import * as core from "@actions/core";
import { constants } from "node:fs";
import {
  lstat,
  open,
  opendir,
  readFile,
  rm,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, normalize, posix, win32 } from "node:path";
import {
  assertCommandTerminationConfirmed,
  inspectExecutable,
  runCommand,
  runElevated,
  sameCommandFileIdentity,
  UnconfirmedCommandTerminationError,
  type CommandFileIdentity,
  type CommandOptions,
} from "./command.js";
import {
  assertSafeExistingTarget,
  assertSafeRemovalTarget,
  captureSafeRemovalBoundary,
  inspectTarget,
  sameRemovalBoundary,
  type RemovalBoundarySnapshot,
} from "./safety.js";
import type {
  CleanupPlan,
  CommandResult,
  ComponentId,
  Operation,
  OperationPhase,
  OperationResult,
  RuntimeContext,
} from "./types.js";

export interface RemovePathOptions {
  readonly id: string;
  readonly component: ComponentId;
  readonly description: string;
  readonly target: string;
  readonly allowedParents: readonly string[];
  readonly context: RuntimeContext;
  readonly blockedBy?: readonly ComponentId[];
  readonly coveredBy?: readonly ComponentId[];
}

export interface RemovePathDependencies {
  readonly inspect?: typeof inspectTarget;
  readonly boundary?: (
    target: string,
    allowedParents: readonly string[],
    context: RuntimeContext,
  ) => Promise<RemovalBoundarySnapshot>;
  readonly anchoredRemove?: typeof removeAnchoredUnixPath;
  readonly windowsLockedRemove?: (
    target: string,
    expectedBoundary: RemovalBoundarySnapshot,
    context: RuntimeContext,
  ) => Promise<void>;
  readonly inspectExecutable?: typeof inspectExecutable;
  readonly commandRunner?: (
    executable: string,
    args: readonly string[],
    options: CommandOptions,
  ) => Promise<CommandResult>;
  readonly hostPlatform?: NodeJS.Platform;
  readonly currentRuntimeExecutable?: string;
  readonly expectedBoundary?: RemovalBoundarySnapshot;
  readonly remove?: typeof rm;
  readonly unlink?: typeof unlink;
  readonly elevate?: typeof runElevated;
}

const PRIVILEGED_ANCHORED_REMOVE_SOURCE = String.raw`
import { constants } from "node:fs";
import { lstat, open, opendir, readFile, rmdir, unlink } from "node:fs/promises";
import { posix } from "node:path";

let input = Buffer.alloc(0);
for await (const chunk of process.stdin) {
  input = Buffer.concat([input, chunk]);
  if (input.length > 131072) throw new Error("anchored removal input exceeded 128 KiB");
}
const spec = JSON.parse(input.toString("utf8"));
const expected = new Map(
  spec.entries.map((entry) => [entry.path, {
    device: BigInt(entry.device),
    inode: BigInt(entry.inode),
    mode: BigInt(entry.mode),
  }]),
);
const descriptorPath = (fd) =>
  (process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd") + "/" + fd;
const expectedAt = (path) => {
  const entry = expected.get(path);
  if (entry === undefined) throw new Error("cleanup target boundary changed at '" + path + "'");
  return entry;
};
const same = (entry, stat) =>
  entry.device === stat.dev && entry.inode === stat.ino && entry.mode === stat.mode;
const assertSameFilesystem = (expectedDevice, actualDevice, path) => {
  if (expectedDevice !== actualDevice) {
    throw new Error("refusing cleanup path that crosses a mounted filesystem at '" + path + "'");
  }
};
const descriptorMountId = async (fd) => {
  if (process.platform !== "linux") return undefined;
  const data = await readFile("/proc/self/fdinfo/" + fd, "utf8");
  if (Buffer.byteLength(data, "utf8") > 4096) {
    throw new Error("mount identity metadata exceeded 4 KiB for descriptor " + fd);
  }
  const matches = [...data.matchAll(/^mnt_id:[ \t]+([0-9]+)[ \t]*$/gm)];
  if (matches.length !== 1 || matches[0][1] === undefined) {
    throw new Error("unable to verify mount identity for descriptor " + fd);
  }
  return BigInt(matches[0][1]);
};
const assertSameMount = (
  expectedDevice,
  actualDevice,
  expectedMountId,
  actualMountId,
  path,
) => {
  assertSameFilesystem(expectedDevice, actualDevice, path);
  if (
    (expectedMountId === undefined) !== (actualMountId === undefined) ||
    (expectedMountId !== undefined && expectedMountId !== actualMountId)
  ) {
    throw new Error("refusing cleanup path that crosses a mounted filesystem at '" + path + "'");
  }
};
const openDirectory = async (path, displayPath) => {
  try {
    return await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (["ELOOP", "ENOENT", "ENOTDIR"].includes(error?.code ?? "")) {
      throw new Error("cleanup target boundary changed before anchored removal at '" + displayPath + "'");
    }
    throw error;
  }
};
const removeContents = async (
  directory,
  expectedDevice,
  expectedMountId,
  displayDirectory,
) => {
  const root = descriptorPath(directory.fd);
  const entries = await opendir(root);
  for await (const entry of entries) {
    if (entry.name === "." || entry.name === ".." || entry.name.includes("/")) {
      throw new Error("directory returned an unsafe entry name");
    }
    const child = posix.join(root, entry.name);
    const displayChild = posix.join(displayDirectory, entry.name);
    const before = await lstat(child, { bigint: true });
    assertSameFilesystem(expectedDevice, before.dev, displayChild);
    if (before.isDirectory() && !before.isSymbolicLink()) {
      let childHandle;
      try {
        childHandle = await openDirectory(child, displayChild);
        const opened = await childHandle.stat({ bigint: true });
        if (before.dev !== opened.dev || before.ino !== opened.ino || before.mode !== opened.mode) {
          throw new Error("directory entry changed before removal: '" + displayChild + "'");
        }
        const childMountId = await descriptorMountId(childHandle.fd);
        assertSameMount(
          expectedDevice,
          opened.dev,
          expectedMountId,
          childMountId,
          displayChild,
        );
        await removeContents(
          childHandle,
          expectedDevice,
          expectedMountId,
          displayChild,
        );
      } finally {
        await childHandle?.close().catch(() => undefined);
      }
      await rmdir(child);
    } else {
      await unlink(child);
    }
  }
};

const target = posix.normalize(posix.resolve(spec.target));
const parts = target.split(posix.sep).filter(Boolean);
if (parts.length === 0) throw new Error("refusing to remove the filesystem root");
const handles = [];
let parent;
let prefix = "";
try {
  parent = await openDirectory(posix.sep, posix.sep);
  handles.push(parent);
  for (const part of parts.slice(0, -1)) {
    prefix = posix.join(posix.sep, prefix, part);
    const opened = await openDirectory(posix.join(descriptorPath(parent.fd), part), prefix);
    handles.push(opened);
    if (!same(expectedAt(prefix), await opened.stat({ bigint: true }))) {
      throw new Error("cleanup target boundary changed before anchored removal at '" + prefix + "'");
    }
    parent = opened;
  }
  const name = parts.at(-1);
  if (name === undefined || parent === undefined) throw new Error("invalid removal target");
  const anchoredTarget = posix.join(descriptorPath(parent.fd), name);
  const before = await lstat(anchoredTarget, { bigint: true });
  const parentStat = await parent.stat({ bigint: true });
  assertSameFilesystem(parentStat.dev, before.dev, target);
  const targetExpected = expectedAt(target);
  if (!same(targetExpected, before)) {
    throw new Error("cleanup target boundary changed before anchored removal at '" + target + "'");
  }
  if (before.isDirectory() && !before.isSymbolicLink()) {
    let targetHandle;
    try {
      targetHandle = await openDirectory(anchoredTarget, target);
      const opened = await targetHandle.stat({ bigint: true });
      if (!same(targetExpected, opened)) {
        throw new Error("cleanup target boundary changed before anchored removal at '" + target + "'");
      }
      const parentMountId = await descriptorMountId(parent.fd);
      const targetMountId = await descriptorMountId(targetHandle.fd);
      assertSameMount(
        parentStat.dev,
        opened.dev,
        parentMountId,
        targetMountId,
        target,
      );
      await removeContents(targetHandle, opened.dev, targetMountId, target);
    } finally {
      await targetHandle?.close().catch(() => undefined);
    }
    await rmdir(anchoredTarget);
  } else {
    await unlink(anchoredTarget);
  }
} finally {
  for (const handle of handles.reverse()) await handle.close().catch(() => undefined);
}
`;

const WINDOWS_POWERSHELL_EXECUTABLE =
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const WINDOWS_SYSTEM32 = "C:\\Windows\\System32";
const WINDOWS_REMOVAL_INPUT_LIMIT_BYTES = 128 * 1024;
const WINDOWS_REMOVAL_TIMEOUT_MS = 10 * 60_000;

const WINDOWS_BOUNDARY_VALIDATOR_SOURCE = String.raw`
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { win32 } from "node:path";

let input = Buffer.alloc(0);
for await (const chunk of process.stdin) {
  input = Buffer.concat([input, chunk]);
  if (input.length > 131072) throw new Error("Windows removal input exceeded 128 KiB");
}
const spec = JSON.parse(input.toString("utf8"));
if (process.platform !== "win32") throw new Error("Windows removal validator ran on a non-Windows host");
if (
  typeof spec.target !== "string" ||
  typeof spec.runtimeExecutable !== "string" ||
  typeof spec.powershellExecutable !== "string"
) {
  throw new Error("Windows removal input is malformed");
}
if (!Array.isArray(spec.entries) || spec.entries.length === 0 || spec.entries.length > 512) {
  throw new Error("Windows removal boundary is malformed");
}
const canonical = (value) => win32.normalize(value).toLowerCase();
if (canonical(process.execPath) !== canonical(spec.runtimeExecutable)) {
  throw new Error("Windows removal validator did not run through the pinned Node executable");
}
const decimal = (value, name) => {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new Error("Windows removal boundary has an invalid " + name);
  }
  return BigInt(value);
};
const assertField = (actual, expected, name) => {
  if (expected !== undefined && actual !== decimal(expected, name)) {
    throw new Error("Windows removal identity changed at " + name);
  }
};
const inspectStableExecutable = async (path, label) => {
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(label + " is not a regular file");
  }
  const handle = await open(path, constants.O_RDONLY);
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(label + " changed before validation");
    }
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const handleAfter = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    for (const value of [handleAfter, pathAfter]) {
      if (
        value.dev !== opened.dev || value.ino !== opened.ino || value.mode !== opened.mode ||
        value.size !== opened.size || value.mtimeNs !== opened.mtimeNs || value.ctimeNs !== opened.ctimeNs
      ) throw new Error(label + " changed during validation");
    }
    return { stat: before, contentSha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
};
const assertExecutable = (actual, expected, label) => {
  if (expected === null || typeof expected !== "object") {
    throw new Error(label + " identity is missing");
  }
  assertField(actual.stat.dev, expected.device, label + " device");
  assertField(actual.stat.ino, expected.inode, label + " inode");
  assertField(actual.stat.mode, expected.mode, label + " mode");
  assertField(actual.stat.size, expected.size, label + " size");
  assertField(actual.stat.mtimeNs, expected.modifiedNanoseconds, label + " mtime");
  assertField(actual.stat.ctimeNs, expected.changedNanoseconds, label + " ctime");
  assertField(actual.stat.uid, expected.userId, label + " owner");
  assertField(actual.stat.gid, expected.groupId, label + " group");
  if (
    typeof expected.contentSha256 !== "string" ||
    actual.contentSha256 !== expected.contentSha256
  ) throw new Error(label + " content changed");
};
const runtime = await inspectStableExecutable(process.execPath, "Windows removal Node executable");
assertExecutable(runtime, spec.runtime, "runtime");
const powershell = await inspectStableExecutable(
  spec.powershellExecutable,
  "fixed Windows PowerShell executable",
);
assertExecutable(powershell, spec.powershell, "PowerShell");

const target = win32.normalize(spec.target);
if (!win32.isAbsolute(target)) throw new Error("Windows removal target is not absolute");
let previous = win32.parse(target).root;
for (const [index, entry] of spec.entries.entries()) {
  if (entry === null || typeof entry !== "object" || typeof entry.path !== "string") {
    throw new Error("Windows removal boundary entry is malformed");
  }
  const path = win32.normalize(entry.path);
  if (canonical(path) !== canonical(entry.path)) {
    throw new Error("Windows removal boundary path is not normalized");
  }
  const relative = win32.relative(previous, path);
  if (
    relative === "" || relative === ".." || relative.startsWith("..\\") ||
    win32.isAbsolute(relative) || relative.includes("\\") || relative.includes("/")
  ) {
    throw new Error("Windows removal boundary omits an ancestor");
  }
  if (index < spec.entries.length - 1) {
    const relativeTarget = win32.relative(path, target);
    if (
      relativeTarget === "" || relativeTarget === ".." ||
      relativeTarget.startsWith("..\\") || win32.isAbsolute(relativeTarget)
    ) throw new Error("Windows removal boundary does not contain the target");
  } else if (canonical(path) !== canonical(target)) {
    throw new Error("Windows removal boundary does not end at the target");
  }
  const actual = await lstat(path, { bigint: true });
  if (
    actual.dev !== decimal(entry.device, "device") ||
    actual.ino !== decimal(entry.inode, "inode") ||
    actual.mode !== decimal(entry.mode, "mode")
  ) throw new Error("Windows removal boundary changed at '" + path + "'");
  previous = path;
}
`;

const WINDOWS_BOUNDARY_VALIDATOR_BASE64 = Buffer.from(
  WINDOWS_BOUNDARY_VALIDATOR_SOURCE,
  "utf8",
).toString("base64");

const WINDOWS_LOCKED_REMOVE_POWERSHELL_SOURCE = [
  String.raw`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$encodedInput = [Console]::In.ReadToEnd()
if ($encodedInput.Length -gt 174764) { throw 'Windows removal input exceeded its encoded bound' }
$inputBytes = [Convert]::FromBase64String($encodedInput)
if ($inputBytes.Length -gt 131072) { throw 'Windows removal input exceeded 128 KiB' }
$jsonInput = [Text.Encoding]::UTF8.GetString($inputBytes)
$spec = $jsonInput | ConvertFrom-Json
$entries = @($spec.entries)
if ($entries.Count -lt 1 -or $entries.Count -gt 512) { throw 'Windows removal boundary is malformed' }
if ([string]::IsNullOrWhiteSpace([string]$spec.target)) { throw 'Windows removal target is missing' }
if ([string]::IsNullOrWhiteSpace([string]$spec.runtimeExecutable)) { throw 'Windows removal runtime is missing' }
if ([string]::IsNullOrWhiteSpace([string]$spec.powershellExecutable)) { throw 'Windows PowerShell runtime is missing' }

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class LockedRemovalNative {
    private const uint DELETE = 0x00010000;
    private const uint FILE_READ_ATTRIBUTES = 0x00000080;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    private const uint INVALID_FILE_ATTRIBUTES = 0xffffffff;
    private const int ERROR_FILE_NOT_FOUND = 2;
    private const int ERROR_NO_MORE_FILES = 18;
    private const int FILE_ATTRIBUTE_TAG_INFO_CLASS = 9;
    private const int FILE_DISPOSITION_INFO_EX_CLASS = 21;
    private const uint FILE_DISPOSITION_FLAG_DELETE = 0x00000001;
    private const uint FILE_DISPOSITION_FLAG_POSIX_SEMANTICS = 0x00000002;
    private const uint FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE = 0x00000010;

    [StructLayout(LayoutKind.Sequential)]
    private struct FileAttributeTagInfo {
        public uint FileAttributes;
        public uint ReparseTag;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileDispositionInfoEx {
        public uint Flags;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct FindData {
        public uint FileAttributes;
        public uint CreationTimeLow;
        public uint CreationTimeHigh;
        public uint LastAccessTimeLow;
        public uint LastAccessTimeHigh;
        public uint LastWriteTimeLow;
        public uint LastWriteTimeHigh;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint Reserved0;
        public uint Reserved1;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string FileName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)]
        public string AlternateFileName;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName, uint desiredAccess, uint shareMode, IntPtr securityAttributes,
        uint creationDisposition, uint flagsAndAttributes, IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(
        SafeFileHandle file, int informationClass, out FileAttributeTagInfo information,
        uint bufferSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFileInformationByHandle(
        SafeFileHandle file, int informationClass, ref FileDispositionInfoEx information,
        uint bufferSize);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFileAttributesW(string fileName);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindFirstFileW(string fileName, out FindData findData);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FindNextFileW(IntPtr findFile, out FindData findData);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FindClose(IntPtr findFile);

    private static string Extended(string path) {
        if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) return path;
        if (path.StartsWith(@"\\", StringComparison.Ordinal)) return @"\\?\UNC\" + path.Substring(2);
        return @"\\?\" + path;
    }

    private static SafeFileHandle Open(string path, uint access) {
        SafeFileHandle handle = CreateFileW(
            Extended(path), access, FILE_SHARE_READ, IntPtr.Zero, OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
        if (handle.IsInvalid) {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error, "Could not lock Windows cleanup path '" + path + "'");
        }
        return handle;
    }

    public static SafeFileHandle OpenAnchor(string path) {
        return Open(path, FILE_READ_ATTRIBUTES);
    }

    public static SafeFileHandle OpenTarget(string path) {
        return Open(path, FILE_READ_ATTRIBUTES | DELETE);
    }

    public static uint Attributes(SafeFileHandle handle) {
        FileAttributeTagInfo information;
        if (!GetFileInformationByHandleEx(
            handle, FILE_ATTRIBUTE_TAG_INFO_CLASS, out information,
            (uint)Marshal.SizeOf(typeof(FileAttributeTagInfo)))) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not inspect locked Windows cleanup path");
        }
        return information.FileAttributes;
    }

    public static bool IsDirectory(uint attributes) {
        return (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    }

    public static bool IsReparsePoint(uint attributes) {
        return (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
    }

    public static string FirstChild(string path) {
        string extended = Extended(path).TrimEnd('\\') + "\\*";
        FindData data;
        IntPtr find = FindFirstFileW(extended, out data);
        if (find == new IntPtr(-1)) {
            int error = Marshal.GetLastWin32Error();
            if (error == ERROR_FILE_NOT_FOUND) return null;
            throw new Win32Exception(error, "Could not enumerate locked Windows cleanup path '" + path + "'");
        }
        try {
            while (true) {
                string name = data.FileName;
                if (name != "." && name != "..") {
                    return path.EndsWith("\\", StringComparison.Ordinal)
                        ? path + name
                        : path + "\\" + name;
                }
                if (FindNextFileW(find, out data)) continue;
                int error = Marshal.GetLastWin32Error();
                if (error == ERROR_NO_MORE_FILES) return null;
                throw new Win32Exception(error, "Could not continue enumerating locked Windows cleanup path '" + path + "'");
            }
        } finally {
            FindClose(find);
        }
    }

    public static void MarkDelete(SafeFileHandle handle) {
        FileDispositionInfoEx information = new FileDispositionInfoEx();
        information.Flags = FILE_DISPOSITION_FLAG_DELETE |
            FILE_DISPOSITION_FLAG_POSIX_SEMANTICS |
            FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE;
        if (!SetFileInformationByHandle(
            handle, FILE_DISPOSITION_INFO_EX_CLASS, ref information,
            (uint)Marshal.SizeOf(typeof(FileDispositionInfoEx)))) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not mark locked Windows cleanup path for deletion");
        }
    }

    public static void AssertAbsent(string path) {
        uint attributes = GetFileAttributesW(Extended(path));
        if (attributes != INVALID_FILE_ATTRIBUTES) {
            throw new InvalidOperationException("Windows cleanup target remained after locked deletion");
        }
        int error = Marshal.GetLastWin32Error();
        if (error != 2 && error != 3) {
            throw new Win32Exception(error, "Could not confirm Windows cleanup target absence");
        }
    }
}
'@ | Out-Null

function Remove-LockedEntry {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][Microsoft.Win32.SafeHandles.SafeFileHandle] $Handle
    )
    $attributes = [LockedRemovalNative]::Attributes($Handle)
    if ([LockedRemovalNative]::IsDirectory($attributes) -and
        -not [LockedRemovalNative]::IsReparsePoint($attributes)) {
        while ($true) {
            $childPath = [LockedRemovalNative]::FirstChild($Path)
            if ($null -eq $childPath) { break }
            $childHandle = [LockedRemovalNative]::OpenTarget($childPath)
            try {
                Remove-LockedEntry -Path $childPath -Handle $childHandle
            } finally {
                $childHandle.Dispose()
            }
            [LockedRemovalNative]::AssertAbsent($childPath)
        }
    }
    [LockedRemovalNative]::MarkDelete($Handle)
}

$anchors = New-Object System.Collections.ArrayList
$runtimeHandle = $null
$powershellHandle = $null
$targetHandle = $null
try {
    for ($index = 0; $index -lt $entries.Count - 1; $index++) {
        [void]$anchors.Add([LockedRemovalNative]::OpenAnchor([string]$entries[$index].path))
    }
    $runtimeHandle = [LockedRemovalNative]::OpenAnchor([string]$spec.runtimeExecutable)
    $powershellHandle = [LockedRemovalNative]::OpenAnchor([string]$spec.powershellExecutable)
    $targetHandle = [LockedRemovalNative]::OpenTarget([string]$spec.target)

    $nodeSourceBase64 = '`,
  WINDOWS_BOUNDARY_VALIDATOR_BASE64,
  String.raw`'
    $nodeExpression = "eval(Buffer.from('$nodeSourceBase64','base64').toString('utf8'))"
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = [string]$spec.runtimeExecutable
    $quote = [char]34
    $startInfo.Arguments = '--input-type=module --eval ' + $quote + $nodeExpression + $quote
    $startInfo.WorkingDirectory = 'C:\Windows\System32'
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardInput = $true
    $validator = New-Object System.Diagnostics.Process
    $validator.StartInfo = $startInfo
    if (-not $validator.Start()) { throw 'Could not start the pinned Node boundary validator' }
    $validator.StandardInput.Write($jsonInput)
    $validator.StandardInput.Close()
    if (-not $validator.WaitForExit(60000)) {
        $validator.Kill()
        $validator.WaitForExit()
        throw 'Pinned Node boundary validation timed out'
    }
    if ($validator.ExitCode -ne 0) {
        throw "Pinned Node boundary validation exited $($validator.ExitCode)"
    }
    $validator.Dispose()

    Remove-LockedEntry -Path ([string]$spec.target) -Handle $targetHandle
    $targetHandle.Dispose()
    $targetHandle = $null
    [LockedRemovalNative]::AssertAbsent([string]$spec.target)
} finally {
    if ($null -ne $targetHandle) { $targetHandle.Dispose() }
    if ($null -ne $powershellHandle) { $powershellHandle.Dispose() }
    if ($null -ne $runtimeHandle) { $runtimeHandle.Dispose() }
    for ($index = $anchors.Count - 1; $index -ge 0; $index--) {
        $anchors[$index].Dispose()
    }
}
`,
].join("");

function trustedWindowsRemovalEnvironment(): NodeJS.ProcessEnv {
  return {
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    PATH: "C:\\Windows\\System32;C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    TEMP: "C:\\Windows\\Temp",
    TMP: "C:\\Windows\\Temp",
    NoDefaultCurrentDirectoryInExePath: "1",
  };
}

function serializedCommandIdentity(identity: CommandFileIdentity): object {
  return {
    device: identity.device.toString(),
    inode: identity.inode.toString(),
    size: identity.size.toString(),
    modifiedNanoseconds: identity.modifiedNanoseconds.toString(),
    ...(identity.changedNanoseconds === undefined
      ? {}
      : { changedNanoseconds: identity.changedNanoseconds.toString() }),
    ...(identity.mode === undefined ? {} : { mode: identity.mode.toString() }),
    ...(identity.userId === undefined
      ? {}
      : { userId: identity.userId.toString() }),
    ...(identity.groupId === undefined
      ? {}
      : { groupId: identity.groupId.toString() }),
    ...(identity.contentSha256 === undefined
      ? {}
      : { contentSha256: identity.contentSha256 }),
  };
}

function assertCompleteWindowsBoundary(
  target: string,
  boundary: RemovalBoundarySnapshot,
): void {
  const normalizedTarget = win32.normalize(target);
  if (!win32.isAbsolute(normalizedTarget)) {
    throw new Error("Windows removal target is not absolute");
  }
  let parent = win32.parse(normalizedTarget).root;
  for (const entry of boundary.entries) {
    const path = win32.normalize(entry.path);
    const relative = win32.relative(parent, path);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith("..\\") ||
      win32.isAbsolute(relative) ||
      relative.includes("\\") ||
      relative.includes("/")
    ) {
      throw new Error("Windows removal boundary omits an ancestor");
    }
    parent = path;
  }
  if (parent.toLowerCase() !== normalizedTarget.toLowerCase()) {
    throw new Error("Windows removal boundary does not end at the target");
  }
}

async function removeLockedWindowsPath(
  target: string,
  expectedBoundary: RemovalBoundarySnapshot,
  context: RuntimeContext,
  dependencies: Pick<
    RemovePathDependencies,
    | "inspectExecutable"
    | "commandRunner"
    | "hostPlatform"
    | "currentRuntimeExecutable"
  >,
): Promise<void> {
  const hostPlatform = dependencies.hostPlatform ?? process.platform;
  const currentRuntimeExecutable =
    dependencies.currentRuntimeExecutable ?? process.execPath;
  if (hostPlatform !== "win32") {
    throw new Error("refusing Windows removal on a non-Windows host");
  }
  if (
    win32.normalize(context.runtimeExecutable).toLowerCase() !==
    win32.normalize(currentRuntimeExecutable).toLowerCase()
  ) {
    throw new Error(
      "Windows removal runtime does not match the current Node executable",
    );
  }
  if (!expectedBoundary.targetExists || expectedBoundary.entries.length === 0) {
    throw new Error(
      "Windows removal boundary does not contain an existing target",
    );
  }
  const inspect = dependencies.inspectExecutable ?? inspectExecutable;
  const run = dependencies.commandRunner ?? runCommand;
  const [powershellIdentity, runtimeIdentity] = await Promise.all([
    inspect(WINDOWS_POWERSHELL_EXECUTABLE),
    inspect(context.runtimeExecutable),
  ]);
  if (powershellIdentity === undefined) {
    throw new Error("fixed Windows PowerShell executable is unavailable");
  }
  if (runtimeIdentity?.contentSha256 === undefined) {
    throw new Error("current Node executable identity is unavailable");
  }

  const serialized = JSON.stringify({
    target: win32.normalize(target),
    runtimeExecutable: win32.normalize(context.runtimeExecutable),
    runtime: serializedCommandIdentity(runtimeIdentity),
    powershellExecutable: WINDOWS_POWERSHELL_EXECUTABLE,
    powershell: serializedCommandIdentity(powershellIdentity),
    entries: expectedBoundary.entries.map((entry) => ({
      path: win32.normalize(entry.path),
      device: entry.device.toString(),
      inode: entry.inode.toString(),
      mode: entry.mode.toString(),
    })),
  });
  if (
    Buffer.byteLength(serialized, "utf8") > WINDOWS_REMOVAL_INPUT_LIMIT_BYTES
  ) {
    throw new Error("Windows removal boundary exceeded 128 KiB");
  }
  assertCompleteWindowsBoundary(target, expectedBoundary);

  const [powershellImmediatelyBefore, runtimeImmediatelyBefore] =
    await Promise.all([
      inspect(WINDOWS_POWERSHELL_EXECUTABLE),
      inspect(context.runtimeExecutable),
    ]);
  if (
    !sameCommandFileIdentity(powershellIdentity, powershellImmediatelyBefore)
  ) {
    throw new Error(
      "fixed Windows PowerShell executable changed before launch",
    );
  }
  if (!sameCommandFileIdentity(runtimeIdentity, runtimeImmediatelyBefore)) {
    throw new Error("current Node executable changed before Windows removal");
  }

  const args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    WINDOWS_LOCKED_REMOVE_POWERSHELL_SOURCE,
  ];
  if (`${WINDOWS_POWERSHELL_EXECUTABLE} ${args.join(" ")}`.length >= 30_000) {
    throw new Error(
      "Windows removal helper exceeded the safe command-line bound",
    );
  }
  assertCommandTerminationConfirmed();
  const result = await run(WINDOWS_POWERSHELL_EXECUTABLE, args, {
    cwd: WINDOWS_SYSTEM32,
    env: trustedWindowsRemovalEnvironment(),
    input: Buffer.from(serialized, "utf8").toString("base64"),
    timeoutMs: WINDOWS_REMOVAL_TIMEOUT_MS,
    silent: true,
  });
  if (result.terminationUnconfirmed === true) {
    throw new UnconfirmedCommandTerminationError(
      "Windows locked removal helper termination is unconfirmed",
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() ||
        `Windows locked removal helper exited ${result.exitCode}`,
    );
  }
}

function serializedRemovalBoundary(
  target: string,
  boundary: RemovalBoundarySnapshot,
): string {
  return JSON.stringify({
    target,
    entries: boundary.entries.map((entry) => ({
      path: entry.path,
      device: entry.device.toString(),
      inode: entry.inode.toString(),
      mode: entry.mode.toString(),
    })),
  });
}

function privilegedRemovalRuntime(context: RuntimeContext): string {
  // On Linux, execute the inode already running this action. A concurrent
  // rename of process.execPath cannot substitute code at the sudo boundary.
  return context.platform === "linux"
    ? `/proc/${process.pid}/exe`
    : context.runtimeExecutable;
}

function unixDescriptorPath(descriptor: number): string {
  return `${process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd"}/${descriptor}`;
}

function sameBoundaryEntry(
  expected: RemovalBoundarySnapshot["entries"][number],
  actual: Awaited<ReturnType<FileHandle["stat"]>>,
): boolean {
  return (
    expected.device === actual.dev &&
    expected.inode === actual.ino &&
    expected.mode === actual.mode
  );
}

export function assertSameRemovalFilesystem(
  expectedDevice: bigint,
  actualDevice: bigint,
  displayPath: string,
): void {
  if (expectedDevice !== actualDevice) {
    throw new Error(
      `refusing cleanup path that crosses a mounted filesystem at '${displayPath}'`,
    );
  }
}

async function unixDescriptorMountId(
  descriptor: number,
): Promise<bigint | undefined> {
  if (process.platform !== "linux") return undefined;
  const data = await readFile(`/proc/self/fdinfo/${descriptor}`, "utf8");
  if (Buffer.byteLength(data, "utf8") > 4096) {
    throw new Error(
      `mount identity metadata exceeded 4 KiB for descriptor ${descriptor}`,
    );
  }
  const matches = [...data.matchAll(/^mnt_id:[ \t]+([0-9]+)[ \t]*$/gm)];
  const mountId = matches[0]?.[1];
  if (matches.length !== 1 || mountId === undefined) {
    throw new Error(
      `unable to verify mount identity for descriptor ${descriptor}`,
    );
  }
  return BigInt(mountId);
}

export function assertSameRemovalMount(
  expectedDevice: bigint,
  actualDevice: bigint,
  expectedMountId: bigint | undefined,
  actualMountId: bigint | undefined,
  displayPath: string,
): void {
  assertSameRemovalFilesystem(expectedDevice, actualDevice, displayPath);
  if (
    (expectedMountId === undefined) !== (actualMountId === undefined) ||
    (expectedMountId !== undefined && expectedMountId !== actualMountId)
  ) {
    throw new Error(
      `refusing cleanup path that crosses a mounted filesystem at '${displayPath}'`,
    );
  }
}

function boundaryEntryFor(
  snapshot: RemovalBoundarySnapshot,
  path: string,
): RemovalBoundarySnapshot["entries"][number] {
  const expected = snapshot.entries.find((entry) => entry.path === path);
  if (expected === undefined) {
    throw new Error(`cleanup target boundary changed at '${path}'`);
  }
  return expected;
}

async function openBoundaryDirectory(
  path: string,
  displayPath: string,
): Promise<FileHandle> {
  try {
    return await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      ["ELOOP", "ENOENT", "ENOTDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    ) {
      throw new Error(
        `cleanup target boundary changed before anchored removal at '${displayPath}'`,
      );
    }
    throw error;
  }
}

async function removeAnchoredDirectoryContents(
  directory: FileHandle,
  expectedDevice: bigint,
  expectedMountId: bigint | undefined,
  displayDirectory: string,
): Promise<void> {
  const root = unixDescriptorPath(directory.fd);
  const entries = await opendir(root);
  for await (const entry of entries) {
    if (entry.name === "." || entry.name === ".." || entry.name.includes("/")) {
      throw new Error("directory returned an unsafe entry name");
    }
    const child = posix.join(root, entry.name);
    const displayChild = posix.join(displayDirectory, entry.name);
    const before = await lstat(child, { bigint: true });
    assertSameRemovalFilesystem(expectedDevice, before.dev, displayChild);
    if (before.isDirectory() && !before.isSymbolicLink()) {
      let childHandle: FileHandle | undefined;
      try {
        childHandle = await openBoundaryDirectory(child, displayChild);
        const opened = await childHandle.stat({ bigint: true });
        if (
          before.dev !== opened.dev ||
          before.ino !== opened.ino ||
          before.mode !== opened.mode
        ) {
          throw new Error(
            `directory entry changed before removal: '${displayChild}'`,
          );
        }
        const childMountId = await unixDescriptorMountId(childHandle.fd);
        assertSameRemovalMount(
          expectedDevice,
          opened.dev,
          expectedMountId,
          childMountId,
          displayChild,
        );
        await removeAnchoredDirectoryContents(
          childHandle,
          expectedDevice,
          expectedMountId,
          displayChild,
        );
      } finally {
        await childHandle?.close().catch(() => undefined);
      }
      await rmdir(child);
    } else {
      await unlink(child);
    }
  }
}

/**
 * Recursively remove a Unix target through no-follow directory handles.
 *
 * The caller's final boundary snapshot is compared to the handles that anchor
 * every ancestor. Once opened, a later pathname swap cannot redirect recursive
 * traversal. Final unlink/rmdir calls are relative to the anchored parent and
 * never recursively follow a replacement entry.
 */
export async function removeAnchoredUnixPath(
  target: string,
  expectedBoundary: RemovalBoundarySnapshot,
): Promise<void> {
  if (!expectedBoundary.targetExists) {
    throw new Error("cleanup target disappeared before anchored removal");
  }
  const normalizedTarget = posix.normalize(posix.resolve(target));
  const parts = normalizedTarget.split(posix.sep).filter(Boolean);
  if (parts.length === 0) {
    throw new Error("refusing to remove the filesystem root");
  }

  const handles: FileHandle[] = [];
  let parent: FileHandle | undefined;
  let prefix = "";
  try {
    parent = await openBoundaryDirectory(posix.sep, posix.sep);
    handles.push(parent);

    for (const part of parts.slice(0, -1)) {
      prefix = posix.join(posix.sep, prefix, part);
      const child = posix.join(unixDescriptorPath(parent.fd), part);
      const opened = await openBoundaryDirectory(child, prefix);
      handles.push(opened);
      const actual = await opened.stat({ bigint: true });
      if (
        !sameBoundaryEntry(boundaryEntryFor(expectedBoundary, prefix), actual)
      ) {
        throw new Error(
          `cleanup target boundary changed before anchored removal at '${prefix}'`,
        );
      }
      parent = opened;
    }

    const name = parts.at(-1);
    if (name === undefined || parent === undefined) {
      throw new Error("cleanup target has no removable final entry");
    }
    const anchoredTarget = posix.join(unixDescriptorPath(parent.fd), name);
    const targetPath = posix.join(posix.sep, ...parts);
    const before = await lstat(anchoredTarget, { bigint: true });
    const parentStat = await parent.stat({ bigint: true });
    assertSameRemovalFilesystem(parentStat.dev, before.dev, targetPath);
    const expected = boundaryEntryFor(expectedBoundary, targetPath);
    if (
      expected.device !== before.dev ||
      expected.inode !== before.ino ||
      expected.mode !== before.mode
    ) {
      throw new Error(
        `cleanup target boundary changed before anchored removal at '${targetPath}'`,
      );
    }

    if (before.isDirectory() && !before.isSymbolicLink()) {
      let targetHandle: FileHandle | undefined;
      try {
        targetHandle = await openBoundaryDirectory(anchoredTarget, targetPath);
        const opened = await targetHandle.stat({ bigint: true });
        if (!sameBoundaryEntry(expected, opened)) {
          throw new Error(
            `cleanup target boundary changed before anchored removal at '${targetPath}'`,
          );
        }
        const parentMountId = await unixDescriptorMountId(parent.fd);
        const targetMountId = await unixDescriptorMountId(targetHandle.fd);
        assertSameRemovalMount(
          parentStat.dev,
          opened.dev,
          parentMountId,
          targetMountId,
          targetPath,
        );
        await removeAnchoredDirectoryContents(
          targetHandle,
          opened.dev,
          targetMountId,
          targetPath,
        );
      } finally {
        await targetHandle?.close().catch(() => undefined);
      }
      await rmdir(anchoredTarget);
    } else {
      await unlink(anchoredTarget);
    }
  } finally {
    for (const handle of handles.reverse()) {
      await handle.close().catch(() => undefined);
    }
  }
}

export async function validateRemovePathTarget(
  target: string,
  allowedParents: readonly string[],
  context: RuntimeContext,
): Promise<void> {
  await assertSafeExistingTarget(target, allowedParents, context);
}

export async function removePathTarget(
  target: string,
  allowedParents: readonly string[],
  context: RuntimeContext,
  dependencies: RemovePathDependencies = {},
): Promise<OperationResult> {
  const inspect = dependencies.inspect ?? inspectTarget;
  const boundary = dependencies.boundary ?? captureSafeRemovalBoundary;
  const anchoredRemove = dependencies.anchoredRemove ?? removeAnchoredUnixPath;
  const windowsLockedRemove =
    dependencies.windowsLockedRemove ??
    (async (
      removalTarget: string,
      expectedBoundary: RemovalBoundarySnapshot,
      runtimeContext: RuntimeContext,
    ) =>
      await removeLockedWindowsPath(
        removalTarget,
        expectedBoundary,
        runtimeContext,
        dependencies,
      ));
  const remove = dependencies.remove ?? rm;
  const unlinkTarget = dependencies.unlink ?? unlink;
  const elevate = dependencies.elevate ?? runElevated;
  const inspected = await inspect(target);
  if (!inspected.exists) {
    const expectedBoundary = dependencies.expectedBoundary;
    if (expectedBoundary?.targetExists !== true) return { status: "not-found" };

    try {
      const currentBoundary = await boundary(target, allowedParents, context);
      const expectedSurvivingPrefix: RemovalBoundarySnapshot = {
        targetExists: false,
        entries: expectedBoundary.entries.slice(
          0,
          currentBoundary.entries.length,
        ),
      };
      if (
        expectedBoundary.entries.length === 0 ||
        currentBoundary.targetExists ||
        currentBoundary.entries.length >= expectedBoundary.entries.length ||
        !sameRemovalBoundary(expectedSurvivingPrefix, currentBoundary)
      ) {
        return {
          status: "failed",
          detail: "cleanup target boundary changed after plan validation",
        };
      }
      return { status: "not-found" };
    } catch {
      return {
        status: "failed",
        detail: "cleanup target boundary changed after plan validation",
      };
    }
  }
  if (dependencies.expectedBoundary?.targetExists === false) {
    return {
      status: "failed",
      detail: "cleanup target appeared after plan validation",
    };
  }
  let validatedBoundary: RemovalBoundarySnapshot;
  try {
    validatedBoundary =
      dependencies.expectedBoundary ??
      (await boundary(target, allowedParents, context));
    if (!validatedBoundary.targetExists) {
      return {
        status: "failed",
        detail: "cleanup target disappeared during boundary validation",
      };
    }
  } catch (error) {
    return {
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const immediateBoundary = await boundary(target, allowedParents, context);
    if (!sameRemovalBoundary(validatedBoundary, immediateBoundary)) {
      return {
        status: "failed",
        detail: "cleanup target boundary changed immediately before removal",
      };
    }
  } catch (error) {
    return {
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    if (context.platform === "windows") {
      await windowsLockedRemove(target, validatedBoundary, context);
    } else if (
      dependencies.remove === undefined &&
      dependencies.unlink === undefined
    ) {
      await anchoredRemove(target, validatedBoundary);
    } else if (inspected.isLink) {
      // Unlink the directory symlink/junction itself. Never give a recursive
      // remover a final link that could be swapped or followed differently.
      await unlinkTarget(target);
    } else {
      await remove(target, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
    return (await inspect(target)).exists
      ? {
          status: "failed",
          detail: "target remained after filesystem removal reported success",
        }
      : { status: "removed" };
  } catch (nodeError) {
    if (context.platform === "windows") {
      return { status: "failed", detail: (nodeError as Error).message };
    }

    const beforeElevation = await inspect(target);
    if (!beforeElevation.exists) return { status: "removed" };
    let fallbackBoundary: RemovalBoundarySnapshot;
    try {
      fallbackBoundary = await boundary(target, allowedParents, context);
      if (!fallbackBoundary.targetExists) {
        return {
          status: "failed",
          detail: "cleanup target disappeared before privileged removal",
        };
      }
      if (!sameRemovalBoundary(validatedBoundary, fallbackBoundary)) {
        return {
          status: "failed",
          detail: "cleanup target boundary changed after local removal failed",
        };
      }
      const immediateBoundary = await boundary(target, allowedParents, context);
      if (!sameRemovalBoundary(fallbackBoundary, immediateBoundary)) {
        return {
          status: "failed",
          detail: "cleanup target boundary changed before privileged removal",
        };
      }
    } catch (error) {
      return {
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (beforeElevation.isLink !== inspected.isLink) {
      return {
        status: "failed",
        detail: "target type changed before privileged removal",
      };
    }
    assertCommandTerminationConfirmed();
    const result = await elevate(
      context,
      privilegedRemovalRuntime(context),
      ["--input-type=module", "--eval", PRIVILEGED_ANCHORED_REMOVE_SOURCE],
      {
        input: serializedRemovalBoundary(target, fallbackBoundary),
        silent: true,
        timeoutMs: 10 * 60_000,
      },
    );
    if (result.exitCode === 0) {
      return (await inspect(target)).exists
        ? {
            status: "failed",
            detail: "target remained after privileged removal reported success",
          }
        : { status: "removed" };
    }
    return {
      status: "failed",
      detail: result.stderr.trim() || (nodeError as Error).message,
    };
  }
}

export function createRemovePathOperation(
  options: RemovePathOptions,
): Operation {
  const target = assertSafeRemovalTarget(
    options.target,
    options.allowedParents,
    options.context,
  );
  let validatedBoundary: RemovalBoundarySnapshot | undefined;
  const validate = async (): Promise<void> => {
    const current = await captureSafeRemovalBoundary(
      target,
      options.allowedParents,
      options.context,
    );
    if (
      validatedBoundary !== undefined &&
      !sameRemovalBoundary(validatedBoundary, current)
    ) {
      throw new Error("cleanup target boundary changed during plan validation");
    }
    validatedBoundary ??= current;
  };
  return {
    id: options.id,
    component: options.component,
    description: options.description,
    phase: "filesystem",
    dedupeKey: `path:${
      options.context.platform === "windows"
        ? win32.normalize(target).toLowerCase()
        : normalize(target)
    }`,
    ...(options.blockedBy === undefined
      ? {}
      : { blockedBy: options.blockedBy }),
    ...(options.coveredBy === undefined
      ? {}
      : { coveredBy: options.coveredBy }),
    validate,
    run: async () => {
      if (validatedBoundary === undefined) {
        try {
          await validate();
        } catch (error) {
          return {
            status: "failed",
            detail: error instanceof Error ? error.message : String(error),
          };
        }
      }
      const expectedBoundary = validatedBoundary;
      if (expectedBoundary === undefined) {
        return {
          status: "failed",
          detail: "cleanup target boundary was not captured during validation",
        };
      }
      return await removePathTarget(
        target,
        options.allowedParents,
        options.context,
        { expectedBoundary },
      );
    },
  };
}

export function createUnsupportedOperation(
  component: ComponentId,
  detail: string,
): Operation {
  return createFunctionOperation({
    id: `unsupported:${component}`,
    component,
    description: `${component} cleanup is not applicable on this runner`,
    phase: "system",
    run: async () => ({ status: "unsupported", detail }),
  });
}

export function createFunctionOperation(options: {
  readonly id: string;
  readonly component: ComponentId;
  readonly description: string;
  readonly phase: OperationPhase;
  readonly dedupeKey?: string;
  readonly blockedBy?: readonly ComponentId[];
  readonly coveredBy?: readonly ComponentId[];
  readonly coveredBySuccessfulOperations?: readonly string[];
  readonly always?: boolean;
  readonly fatal?: boolean;
  readonly validate?: () => Promise<void>;
  readonly rollback?: () => Promise<void>;
  readonly rollbackAfterPayloadMutation?: boolean;
  readonly run: () => Promise<OperationResult>;
}): Operation {
  return {
    id: options.id,
    component: options.component,
    description: options.description,
    phase: options.phase,
    ...(options.dedupeKey === undefined
      ? {}
      : { dedupeKey: options.dedupeKey }),
    ...(options.blockedBy === undefined
      ? {}
      : { blockedBy: options.blockedBy }),
    ...(options.coveredBy === undefined
      ? {}
      : { coveredBy: options.coveredBy }),
    ...(options.coveredBySuccessfulOperations === undefined
      ? {}
      : {
          coveredBySuccessfulOperations: options.coveredBySuccessfulOperations,
        }),
    ...(options.always === undefined ? {} : { always: options.always }),
    ...(options.fatal === undefined ? {} : { fatal: options.fatal }),
    ...(options.validate === undefined ? {} : { validate: options.validate }),
    ...(options.rollback === undefined ? {} : { rollback: options.rollback }),
    ...(options.rollbackAfterPayloadMutation === undefined
      ? {}
      : {
          rollbackAfterPayloadMutation: options.rollbackAfterPayloadMutation,
        }),
    run: options.run,
  };
}

export function prepareOperations(
  operations: readonly Operation[],
  plan: CleanupPlan,
): readonly Operation[] {
  const byKey = new Map<string, Operation>();
  const prepared: Operation[] = [];
  for (const operation of operations) {
    if (operation.always !== true && !plan.enabled.has(operation.component)) {
      continue;
    }
    if (operation.blockedBy?.some((component) => plan.skipped.has(component))) {
      continue;
    }
    if (operation.coveredBy?.some((component) => plan.enabled.has(component))) {
      continue;
    }
    if (operation.dedupeKey === undefined) {
      prepared.push(operation);
      continue;
    }
    if (!byKey.has(operation.dedupeKey)) {
      byKey.set(operation.dedupeKey, operation);
      prepared.push(operation);
    }
  }
  return prepared;
}

async function runOne(operation: Operation): Promise<OperationResult> {
  core.info(`• ${operation.description}`);
  assertCommandTerminationConfirmed();
  let result: OperationResult;
  try {
    result = await operation.run();
  } catch (error) {
    if (error instanceof UnconfirmedCommandTerminationError) throw error;
    assertCommandTerminationConfirmed();
    const detail = error instanceof Error ? error.message : String(error);
    core.warning(`${operation.description} failed: ${detail}`);
    throw error;
  }
  assertCommandTerminationConfirmed();
  const suffix = result.detail === undefined ? "" : `: ${result.detail}`;
  if (result.status === "failed") {
    core.warning(`${operation.description} failed${suffix}`);
    throw new Error(`${operation.description} failed${suffix}`);
  } else if (result.status !== "not-found") {
    core.info(`  ${result.status}${suffix}`);
  }
  return result;
}

const PHASES = ["preflight", "package", "filesystem", "system"] as const;

function assertValidResultCoverage(operations: readonly Operation[]): void {
  const byId = new Map<string, Operation[]>();
  for (const operation of operations) {
    const matching = byId.get(operation.id) ?? [];
    matching.push(operation);
    byId.set(operation.id, matching);
  }

  const executionOrder = new Map<Operation, number>();
  let cursor = 0;
  for (const phase of PHASES) {
    for (const operation of operations) {
      if (operation.phase === phase) executionOrder.set(operation, cursor++);
    }
  }

  for (const operation of operations) {
    for (const coveringId of operation.coveredBySuccessfulOperations ?? []) {
      const covering = byId.get(coveringId) ?? [];
      if (covering.length === 0) continue;
      if (covering.length > 1) {
        throw new Error(
          `${operation.id} has an ambiguous successful-operation coverage dependency on ${coveringId}`,
        );
      }
      const coveringOperation = covering[0];
      if (coveringOperation === undefined) continue;
      const coveringOrder = executionOrder.get(coveringOperation);
      const fallbackOrder = executionOrder.get(operation);
      if (
        coveringOrder === undefined ||
        fallbackOrder === undefined ||
        coveringOrder >= fallbackOrder ||
        (operation.phase === "filesystem" &&
          coveringOperation.phase === "filesystem")
      ) {
        throw new Error(
          `${operation.id} must run after its serialized coverage dependency ${coveringId}`,
        );
      }
    }
  }
}

function successfulCoveringOperation(
  operation: Operation,
  resultsById: ReadonlyMap<string, OperationResult>,
): string | undefined {
  return operation.coveredBySuccessfulOperations?.find(
    (id) => resultsById.get(id)?.status === "removed",
  );
}

function isCoveredBySuccessfulOperation(
  operation: Operation,
  resultsById: ReadonlyMap<string, OperationResult>,
): boolean {
  const coveringId = successfulCoveringOperation(operation, resultsById);
  if (coveringId === undefined) return false;
  core.info(`• ${operation.description} (covered by successful ${coveringId})`);
  return true;
}

export async function executeOperations(
  operations: readonly Operation[],
): Promise<readonly OperationResult[]> {
  assertCommandTerminationConfirmed();
  assertValidResultCoverage(operations);
  const validationFailures: string[] = [];
  for (const operation of operations) {
    if (operation.validate === undefined) continue;
    try {
      await operation.validate();
      assertCommandTerminationConfirmed();
    } catch (error) {
      if (error instanceof UnconfirmedCommandTerminationError) throw error;
      assertCommandTerminationConfirmed();
      const detail = error instanceof Error ? error.message : String(error);
      validationFailures.push(`${operation.description}: ${detail}`);
    }
  }
  if (validationFailures.length > 0) {
    throw new Error(
      `Cleanup plan validation failed before mutation:\n${validationFailures.join("\n")}`,
    );
  }

  const results: OperationResult[] = [];
  const resultsById = new Map<string, OperationResult>();
  const reversible: Operation[] = [];
  let payloadMutationMayHaveStarted = false;
  try {
    for (const phase of PHASES) {
      const phaseOperations = operations.filter(
        (operation) => operation.phase === phase,
      );
      if (phaseOperations.length === 0) continue;
      await core.group(`${phase} cleanup`, async () => {
        if (phase === "filesystem") {
          const eligible = phaseOperations.filter(
            (operation) =>
              !isCoveredBySuccessfulOperation(operation, resultsById),
          );
          // Destructive path removals are deliberately serialized. If a command
          // timeout cannot prove its process tree ended, no sibling deletion may
          // already be in flight when the fatal termination latch is observed.
          for (const operation of eligible) {
            payloadMutationMayHaveStarted = true;
            const result = await runOne(operation);
            results.push(result);
            resultsById.set(operation.id, result);
            if (
              result.status === "removed" &&
              operation.rollback !== undefined
            ) {
              reversible.push(operation);
            }
          }
          return;
        }

        for (const operation of phaseOperations) {
          if (isCoveredBySuccessfulOperation(operation, resultsById)) continue;
          if (phase !== "preflight") payloadMutationMayHaveStarted = true;
          const result = await runOne(operation);
          results.push(result);
          resultsById.set(operation.id, result);
          if (result.status === "removed" && operation.rollback !== undefined) {
            reversible.push(operation);
          }
        }
      });
    }
  } catch (error) {
    // Never start rollback commands while an unconfirmed timed-out process may
    // still be mutating the same runner. The termination error remains primary.
    assertCommandTerminationConfirmed();
    const rollbackFailures: string[] = [];
    for (const operation of [...reversible].reverse()) {
      if (
        payloadMutationMayHaveStarted &&
        operation.rollbackAfterPayloadMutation !== true
      ) {
        continue;
      }
      try {
        assertCommandTerminationConfirmed();
        await operation.rollback?.();
        assertCommandTerminationConfirmed();
      } catch (rollbackError) {
        if (rollbackError instanceof UnconfirmedCommandTerminationError) {
          throw rollbackError;
        }
        assertCommandTerminationConfirmed();
        rollbackFailures.push(
          `${operation.description}: ${
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError)
          }`,
        );
      }
    }
    if (rollbackFailures.length > 0) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${detail}; rollback failed: ${rollbackFailures.join("; ")}`,
        { cause: error },
      );
    }
    throw error;
  }
  assertCommandTerminationConfirmed();
  return results;
}

export function parentOf(target: string): string {
  return dirname(normalize(target));
}
