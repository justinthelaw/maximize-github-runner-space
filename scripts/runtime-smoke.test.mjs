import assert from "node:assert/strict";
import test from "node:test";
import {
  PYTHON_SMOKE_SOURCE,
  WINDOWS_POWERSHELL_TIMEOUT_MS,
  runFirstWorkingPython,
  runRuntime,
  windowsCandidates,
} from "./runtime-smoke-lib.mjs";

function whereResult(status, stdout = "", stderr = "") {
  return { status, stdout, stderr };
}

test("Windows Python discovery accepts only the expected where.exe miss", () => {
  const candidates = windowsCandidates("C:\\Windows", ["python.exe"], () =>
    whereResult(
      1,
      "",
      "INFO: Could not find files for the given pattern(s).\r\n",
    ),
  );
  assert.deepEqual(candidates, []);

  assert.throws(
    () =>
      windowsCandidates("C:\\Windows", ["python.exe"], () =>
        whereResult(1, "", "Access is denied."),
      ),
    /Access is denied/,
  );
});

test("Windows Python discovery records py.exe launcher arguments", () => {
  const candidates = windowsCandidates("C:\\Windows", ["py.exe"], () =>
    whereResult(0, "C:\\Windows\\py.exe\r\n"),
  );
  assert.deepEqual(candidates, [
    { executable: "C:\\Windows\\py.exe", launcherArgs: ["-3"] },
  ]);
});

test("Windows Python discovery rejects malformed successful output", () => {
  assert.throws(
    () =>
      windowsCandidates("C:\\Windows", ["python.exe"], () => whereResult(0)),
    /returned no path/,
  );
  assert.throws(
    () =>
      windowsCandidates("C:\\Windows", ["python.exe"], () =>
        whereResult(0, "relative\\python.exe\r\n"),
      ),
    /unsafe path/,
  );
});

test("Windows Python smoke rejects present-but-broken candidates", () => {
  const candidates = [
    { executable: "C:\\Python\\python.exe", launcherArgs: [] },
    { executable: "C:\\Windows\\py.exe", launcherArgs: ["-3"] },
  ];
  assert.throws(
    () =>
      runFirstWorkingPython(candidates, () => {
        throw new Error("candidate is broken");
      }),
    /candidate is broken/,
  );
  assert.equal(
    runFirstWorkingPython([], () => undefined),
    false,
  );
});

test("Windows Python smoke advances to a working candidate", () => {
  const observed = [];
  const candidates = [
    { executable: "C:\\Broken\\python.exe", launcherArgs: [] },
    { executable: "C:\\Windows\\py.exe", launcherArgs: ["-3"] },
  ];
  const worked = runFirstWorkingPython(
    candidates,
    (_label, executable, args) => {
      observed.push({ executable, args });
      if (executable.includes("Broken")) throw new Error("broken");
    },
  );
  assert.equal(worked, true);
  assert.deepEqual(observed, [
    {
      executable: "C:\\Broken\\python.exe",
      args: ["-I", "-S", "-c", PYTHON_SMOKE_SOURCE],
    },
    {
      executable: "C:\\Windows\\py.exe",
      args: ["-3", "-I", "-S", "-c", PYTHON_SMOKE_SOURCE],
    },
  ]);
});

test("runtime smoke strips language startup injection variables", () => {
  const original = {
    BASH_ENV: process.env.BASH_ENV,
    ENV: process.env.ENV,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    NODE_PATH: process.env.NODE_PATH,
    PERL5LIB: process.env.PERL5LIB,
    PERL5OPT: process.env.PERL5OPT,
    PYTHONHOME: process.env.PYTHONHOME,
    PYTHONPATH: process.env.PYTHONPATH,
  };
  for (const key of Object.keys(original)) process.env[key] = "hostile";
  let observedEnvironment;
  try {
    runRuntime("mock", process.execPath, [], (_executable, _args, options) => {
      observedEnvironment = options.env;
      return { status: 0, stdout: "", stderr: "" };
    });
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.ok(observedEnvironment);
  for (const key of Object.keys(original)) {
    assert.equal(observedEnvironment[key], undefined, key);
  }
});

test("runtime smoke permits bounded legacy PowerShell startup", () => {
  let observedTimeout;
  runRuntime(
    "Windows PowerShell",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    [],
    (_executable, _args, options) => {
      observedTimeout = options.timeout;
      return { status: 0, stdout: "", stderr: "" };
    },
    WINDOWS_POWERSHELL_TIMEOUT_MS,
  );
  assert.equal(observedTimeout, WINDOWS_POWERSHELL_TIMEOUT_MS);
});
