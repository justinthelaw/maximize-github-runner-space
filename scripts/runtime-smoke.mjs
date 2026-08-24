import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  PYTHON_SMOKE_SOURCE,
  runFirstWorkingPython,
  runOptional,
  runRuntime,
  windowsCandidates,
} from "./runtime-smoke-lib.mjs";

runRuntime("Node.js", process.execPath, [
  "-e",
  'const value = JSON.parse("{\\"status\\":\\"ok\\"}"); if (value.status !== "ok") process.exit(1)',
]);

if (process.platform === "win32") {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  runRuntime("cmd.exe", join(systemRoot, "System32", "cmd.exe"), [
    "/d",
    "/s",
    "/c",
    'if "runtime-ok"=="runtime-ok" (exit /b 0) else (exit /b 1)',
  ]);
  runRuntime(
    "Windows PowerShell",
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      '$value = ConvertFrom-Json \'{"status":"ok"}\'; if ($value.status -ne "ok") { exit 1 }',
    ],
  );

  const pythonCandidates = windowsCandidates(systemRoot, [
    "python3.exe",
    "python.exe",
    "py.exe",
  ]);
  if (!runFirstWorkingPython(pythonCandidates)) {
    process.stdout.write("runtime smoke: Python unavailable (skipped)\n");
  }
} else {
  runRuntime("Bash", "/bin/bash", [
    "--noprofile",
    "--norc",
    "-c",
    'set -euo pipefail; value=runtime-ok; [[ "$value" == runtime-ok ]]',
  ]);
  runRuntime("POSIX sh", "/bin/sh", [
    "-c",
    'set -eu; test "$(printf %s runtime-ok)" = runtime-ok',
  ]);
  runOptional("OS Python", "/usr/bin/python3", [
    "-I",
    "-S",
    "-c",
    PYTHON_SMOKE_SOURCE,
  ]);
  runOptional("Perl", "/usr/bin/perl", [
    "-e",
    'use strict; use warnings; exit(("runtime-ok" eq "runtime-ok") ? 0 : 1);',
  ]);
  const awk = ["/usr/bin/awk", "/bin/awk"].find(existsSync);
  if (awk === undefined) {
    process.stdout.write("runtime smoke: awk unavailable (skipped)\n");
  } else {
    runRuntime("awk", awk, [
      'BEGIN { if ("runtime-ok" != "runtime-ok") exit 1 }',
    ]);
  }
}
