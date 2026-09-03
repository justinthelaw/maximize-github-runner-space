import assert from "node:assert/strict";
import { constants, type Dirent } from "node:fs";
import test from "node:test";
import { COMPONENTS } from "../src/components.js";
import {
  createMacOSAdapter,
  resolveDefinitionBrewExecutable,
  validateDefinitionBrewConfigRoot,
  type BrewConfigProbe,
  type BrewConfigRootProbe,
  type BrewPathProbe,
  type MacOSBrewRunner,
} from "../src/platforms/macos.js";
import type { Architecture, CleanupPlan, ComponentId } from "../src/types.js";
import { contextFor, planFor } from "./helpers.js";

const symlinkStats = {
  isFile: () => false,
  isSymbolicLink: () => true,
};

const fileStats = {
  isFile: () => true,
  isSymbolicLink: () => false,
};

const BREW_PATHS: Readonly<
  Record<
    Architecture,
    { candidate: string; candidateKind: "file" | "symlink"; executable: string }
  >
> = {
  arm64: {
    candidate: "/opt/homebrew/bin/brew",
    candidateKind: "file",
    executable: "/opt/homebrew/bin/brew",
  },
  x64: {
    candidate: "/usr/local/bin/brew",
    candidateKind: "symlink",
    executable: "/usr/local/Homebrew/bin/brew",
  },
};

function xcodeEntry(
  name: string,
  kind: "directory" | "symlink" = "directory",
): Dirent {
  return {
    name,
    isDirectory: () => kind === "directory",
    isSymbolicLink: () => kind === "symlink",
  } as Dirent;
}

function xcodeSelect(path: string, exitCode = 0) {
  return { exitCode, stdout: `${path}\n`, stderr: "" };
}

const SELECTED_XCODE = "/Applications/Xcode_16.4.app";
const SELECTED_DEVELOPER = `${SELECTED_XCODE}/Contents/Developer`;
const COMMAND_LINE_TOOLS = "/Library/Developer/CommandLineTools";

test("macOS cleans unselected Xcode bundles when Command Line Tools are selected", async () => {
  const removalCalls: string[] = [];
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => xcodeSelect(COMMAND_LINE_TOOLS),
    resolveXcodePath: async (path) =>
      path === "/Applications/Xcode.app" ? SELECTED_XCODE : path,
    listApplications: async () => [
      xcodeEntry("Xcode.app", "symlink"),
      xcodeEntry("Xcode_16.4.app"),
      xcodeEntry("Xcode_15.4.app"),
    ],
    validateXcodeRemoval: async () => {},
    removeXcodeTarget: async (target) => {
      removalCalls.push(target);
      return { status: "removed" };
    },
  });

  const operations = await adapter.operations(planFor("xcode"));
  assert.deepEqual(
    operations.map(({ id }) => id),
    ["xcode:Xcode_15.4.app"],
  );
  const [removal] = operations;
  assert.ok(removal?.validate);
  await removal.validate();

  assert.deepEqual(await removal.run(), { status: "removed" });
  assert.deepEqual(removalCalls, ["/Applications/Xcode_15.4.app"]);
});

test("macOS cleans versioned Xcodes when Command Line Tools are selected without an Xcode alias", async () => {
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => xcodeSelect(COMMAND_LINE_TOOLS),
    resolveXcodePath: async (path) =>
      path === "/Applications/Xcode.app" ? undefined : path,
    listApplications: async () => [
      xcodeEntry("Xcode_16.4.app"),
      xcodeEntry("Xcode_15.4.app"),
    ],
    validateXcodeRemoval: async () => {},
    removeXcodeTarget: async () => ({ status: "removed" }),
  });

  assert.deepEqual(
    (await adapter.operations(planFor("xcode"))).map(({ id }) => id),
    ["xcode:Xcode_16.4.app", "xcode:Xcode_15.4.app"],
  );
});

test("macOS blocks a Command Line Tools cleanup when the Xcode alias retargets at the removal boundary", async () => {
  const target = "/Applications/Xcode_15.4.app";
  let aliasTarget = SELECTED_XCODE;
  let boundaryActive = false;
  let aliasRetargeted = false;
  let mutationCalls = 0;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => xcodeSelect(COMMAND_LINE_TOOLS),
    resolveXcodePath: async (path) => {
      if (path !== "/Applications/Xcode.app") return path;
      const resolved = aliasTarget;
      if (boundaryActive && !aliasRetargeted) {
        aliasRetargeted = true;
        aliasTarget = target;
      }
      return resolved;
    },
    listApplications: async () => [
      xcodeEntry("Xcode.app", "symlink"),
      xcodeEntry("Xcode_16.4.app"),
      xcodeEntry("Xcode_15.4.app"),
    ],
    validateXcodeRemoval: async () => {},
    removeXcodeTarget: async (
      _target,
      _allowedParents,
      _context,
      removalDependencies,
    ) => {
      const beforeMutation = removalDependencies?.beforeMutation;
      assert.ok(beforeMutation);
      boundaryActive = true;
      try {
        await beforeMutation("local", {
          exists: true,
          isLink: false,
          realPath: target,
          identity: { device: 1n, inode: 1n },
        });
      } catch (error) {
        return {
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      mutationCalls += 1;
      return { status: "removed" };
    },
  });
  const removal = (await adapter.operations(planFor("xcode"))).find(
    ({ id }) => id === "xcode:Xcode_15.4.app",
  );
  assert.ok(removal?.validate);
  await removal.validate();

  const result = await removal.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /Xcode selection changed/);
  assert.equal(aliasRetargeted, true);
  assert.equal(mutationCalls, 0);
});

test("macOS blocks Command Line Tools cleanup when the active selection changes at the removal boundary", async () => {
  const target = "/Applications/Xcode_15.4.app";
  let selectedDeveloper = COMMAND_LINE_TOOLS;
  let mutationCalls = 0;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => xcodeSelect(selectedDeveloper),
    resolveXcodePath: async (path) =>
      path === "/Applications/Xcode.app" ? SELECTED_XCODE : path,
    listApplications: async () => [
      xcodeEntry("Xcode.app", "symlink"),
      xcodeEntry("Xcode_16.4.app"),
      xcodeEntry("Xcode_15.4.app"),
    ],
    validateXcodeRemoval: async () => {},
    removeXcodeTarget: async (
      _target,
      _allowedParents,
      _context,
      removalDependencies,
    ) => {
      const beforeMutation = removalDependencies?.beforeMutation;
      assert.ok(beforeMutation);
      selectedDeveloper = `${target}/Contents/Developer`;
      try {
        await beforeMutation("local", {
          exists: true,
          isLink: false,
          realPath: target,
          identity: { device: 1n, inode: 1n },
        });
      } catch (error) {
        return {
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      mutationCalls += 1;
      return { status: "removed" };
    },
  });
  const removal = (await adapter.operations(planFor("xcode"))).find(
    ({ id }) => id === "xcode:Xcode_15.4.app",
  );
  assert.ok(removal?.validate);
  await removal.validate();

  const result = await removal.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /Xcode selection changed/);
  assert.equal(mutationCalls, 0);
});

test("macOS rejects an unstable resolved Command Line Tools selection", async () => {
  let commandLineToolsResolutions = 0;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => xcodeSelect(COMMAND_LINE_TOOLS),
    resolveXcodePath: async (path) => {
      if (path === "/Applications/Xcode.app") return SELECTED_XCODE;
      if (path === COMMAND_LINE_TOOLS && ++commandLineToolsResolutions > 1) {
        return `${SELECTED_XCODE}/Contents/Developer`;
      }
      return path;
    },
    listApplications: async () => [xcodeEntry("Xcode_15.4.app")],
    validateXcodeRemoval: async () => {},
    removeXcodeTarget: async () => ({ status: "removed" }),
  });

  const operations = await adapter.operations(planFor("xcode"));

  assert.deepEqual(
    operations.map(({ id }) => id),
    ["xcode:inventory"],
  );
  assert.deepEqual(await operations[0]?.run(), {
    status: "failed",
    detail:
      "Xcode selection changed while it was being resolved; no Xcode bundle was removed.",
  });
});

test("macOS rejects arbitrary developer directories outside an Xcode bundle", async () => {
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () =>
      xcodeSelect("/Library/Developer/UnexpectedTools"),
    resolveXcodePath: async (path) => path,
    listApplications: async () => [xcodeEntry("Xcode_15.4.app")],
    validateXcodeRemoval: async () => {},
    removeXcodeTarget: async () => ({ status: "removed" }),
  });

  const operations = await adapter.operations(planFor("xcode"));

  assert.deepEqual(
    operations.map(({ id }) => id),
    ["xcode:inventory"],
  );
  const [inventoryFailure] = operations;
  assert.ok(inventoryFailure);
  assert.equal((await inventoryFailure.run()).status, "failed");
});

test("macOS revalidates stable Xcode selection immediately before removal", async () => {
  let selectionCalls = 0;
  const validationCalls: string[] = [];
  const removalCalls: string[] = [];
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => {
      selectionCalls += 1;
      return xcodeSelect(SELECTED_DEVELOPER);
    },
    resolveXcodePath: async (path) => path,
    listApplications: async () => [
      xcodeEntry("Xcode.app", "symlink"),
      xcodeEntry("Xcode_16.4.app"),
      xcodeEntry("Xcode_15.4.app"),
    ],
    validateXcodeRemoval: async (target) => {
      validationCalls.push(target);
    },
    removeXcodeTarget: async (target) => {
      removalCalls.push(target);
      return { status: "removed" };
    },
  });
  const operations = await adapter.operations(planFor("xcode"));
  const removal = operations.find(({ id }) => id === "xcode:Xcode_15.4.app");
  assert.ok(removal?.validate);

  await removal.validate();
  assert.deepEqual(await removal.run(), { status: "removed" });
  assert.equal(selectionCalls, 9);
  assert.deepEqual(validationCalls, [
    "/Applications/Xcode_15.4.app",
    "/Applications/Xcode_15.4.app",
  ]);
  assert.deepEqual(removalCalls, ["/Applications/Xcode_15.4.app"]);
});

test("macOS refuses Xcode removal without a plan-validation snapshot", async () => {
  let selectionCalls = 0;
  let removalCalls = 0;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => {
      selectionCalls += 1;
      return xcodeSelect(SELECTED_DEVELOPER);
    },
    resolveXcodePath: async (path) => path,
    listApplications: async () => [
      xcodeEntry("Xcode_16.4.app"),
      xcodeEntry("Xcode_15.4.app"),
    ],
    validateXcodeRemoval: async () => {},
    removeXcodeTarget: async () => {
      removalCalls += 1;
      return { status: "removed" };
    },
  });
  const removal = (await adapter.operations(planFor("xcode"))).find(
    ({ id }) => id === "xcode:Xcode_15.4.app",
  );
  assert.ok(removal);

  const result = await removal.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /validation snapshot/);
  assert.equal(selectionCalls, 3);
  assert.equal(removalCalls, 0);
});

test("macOS refuses Xcode removal after developer-directory selection drift", async () => {
  let selectionCalls = 0;
  let removalCalls = 0;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => {
      selectionCalls += 1;
      return xcodeSelect(
        selectionCalls < 7
          ? SELECTED_DEVELOPER
          : "/Applications/Xcode_15.4.app/Contents/Developer",
      );
    },
    resolveXcodePath: async (path) => path,
    listApplications: async () => [
      xcodeEntry("Xcode_16.4.app"),
      xcodeEntry("Xcode_15.4.app"),
    ],
    validateXcodeRemoval: async () => {},
    removeXcodeTarget: async () => {
      removalCalls += 1;
      return { status: "removed" };
    },
  });
  const removal = (await adapter.operations(planFor("xcode"))).find(
    ({ id }) => id === "xcode:Xcode_15.4.app",
  );
  assert.ok(removal?.validate);
  await removal.validate();

  const result = await removal.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /Xcode selection changed/);
  assert.equal(removalCalls, 0, "selection drift must fail before deletion");
});

test("macOS refuses Xcode removal after selected-bundle realpath drift", async () => {
  const selectedSpelling = "/Applications/Xcode.app";
  const selectedDeveloper = `${selectedSpelling}/Contents/Developer`;
  let selectionCalls = 0;
  let selectedVersion = SELECTED_XCODE;
  let removalCalls = 0;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => {
      selectionCalls += 1;
      if (selectionCalls === 7) {
        selectedVersion = "/Applications/Xcode_15.4.app";
      }
      return xcodeSelect(selectedDeveloper);
    },
    resolveXcodePath: async (path) => {
      if (path === selectedSpelling) return selectedVersion;
      if (path === selectedDeveloper)
        return `${selectedVersion}/Contents/Developer`;
      return path;
    },
    listApplications: async () => [
      xcodeEntry("Xcode_16.4.app"),
      xcodeEntry("Xcode_15.4.app"),
    ],
    validateXcodeRemoval: async () => {},
    removeXcodeTarget: async () => {
      removalCalls += 1;
      return { status: "removed" };
    },
  });
  const removal = (await adapter.operations(planFor("xcode"))).find(
    ({ id }) => id === "xcode:Xcode_15.4.app",
  );
  assert.ok(removal?.validate);
  await removal.validate();

  const result = await removal.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /Xcode selection changed/);
  assert.equal(removalCalls, 0);
});

test("macOS samples Xcode selection after removal-candidate resolution", async () => {
  const target = "/Applications/Xcode_15.4.app";
  let selectedDeveloper = SELECTED_DEVELOPER;
  let targetResolutions = 0;
  let removalCalls = 0;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => xcodeSelect(selectedDeveloper),
    resolveXcodePath: async (path) => {
      if (path === target && ++targetResolutions === 2) {
        selectedDeveloper = `${target}/Contents/Developer`;
      }
      return path;
    },
    listApplications: async () => [
      xcodeEntry("Xcode_16.4.app"),
      xcodeEntry("Xcode_15.4.app"),
    ],
    validateXcodeRemoval: async () => {},
    removeXcodeTarget: async () => {
      removalCalls += 1;
      return { status: "removed" };
    },
  });
  const removal = (await adapter.operations(planFor("xcode"))).find(
    ({ id }) => id === "xcode:Xcode_15.4.app",
  );
  assert.ok(removal?.validate);
  await removal.validate();

  const result = await removal.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /Xcode selection changed/);
  assert.ok(targetResolutions >= 2);
  assert.equal(removalCalls, 0);
});

test("macOS samples Xcode selection after run-time target validation", async () => {
  const target = "/Applications/Xcode_15.4.app";
  let selectedDeveloper = SELECTED_DEVELOPER;
  let validations = 0;
  let removalCalls = 0;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => xcodeSelect(selectedDeveloper),
    resolveXcodePath: async (path) => path,
    listApplications: async () => [
      xcodeEntry("Xcode_16.4.app"),
      xcodeEntry("Xcode_15.4.app"),
    ],
    validateXcodeRemoval: async () => {
      validations += 1;
      if (validations === 2) {
        selectedDeveloper = `${target}/Contents/Developer`;
      }
    },
    removeXcodeTarget: async () => {
      removalCalls += 1;
      return { status: "removed" };
    },
  });
  const removal = (await adapter.operations(planFor("xcode"))).find(
    ({ id }) => id === "xcode:Xcode_15.4.app",
  );
  assert.ok(removal?.validate);
  await removal.validate();

  const result = await removal.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /Xcode selection changed/);
  assert.equal(validations, 2);
  assert.equal(removalCalls, 0);
});

test("macOS closes Xcode selection observation around boundary path resolution", async () => {
  const target = "/Applications/Xcode_15.4.app";
  let selectedDeveloper = SELECTED_DEVELOPER;
  let boundaryActive = false;
  let selectionFlipped = false;
  let mutationCalls = 0;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => xcodeSelect(selectedDeveloper),
    resolveXcodePath: async (path) => {
      if (boundaryActive && !selectionFlipped && path === SELECTED_DEVELOPER) {
        selectionFlipped = true;
        selectedDeveloper = `${target}/Contents/Developer`;
      }
      return path;
    },
    listApplications: async () => [
      xcodeEntry("Xcode_16.4.app"),
      xcodeEntry("Xcode_15.4.app"),
    ],
    validateXcodeRemoval: async () => {},
    removeXcodeTarget: async (
      _target,
      _allowedParents,
      _context,
      removalDependencies,
    ) => {
      const beforeMutation = removalDependencies?.beforeMutation;
      assert.ok(beforeMutation);
      boundaryActive = true;
      try {
        await beforeMutation("local", {
          exists: true,
          isLink: false,
          realPath: target,
          identity: { device: 1n, inode: 1n },
        });
      } catch (error) {
        return {
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      mutationCalls += 1;
      return { status: "removed" };
    },
  });
  const removal = (await adapter.operations(planFor("xcode"))).find(
    ({ id }) => id === "xcode:Xcode_15.4.app",
  );
  assert.ok(removal?.validate);
  await removal.validate();

  const result = await removal.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /Xcode selection changed/);
  assert.equal(selectionFlipped, true);
  assert.equal(mutationCalls, 0);
});

test("macOS closes resolved Xcode alias observation around boundary resolution", async () => {
  const selectedSpelling = "/Applications/Xcode.app";
  const selectedDeveloper = `${selectedSpelling}/Contents/Developer`;
  const target = "/Applications/Xcode_15.4.app";
  let selectedBundle = SELECTED_XCODE;
  let boundaryActive = false;
  let aliasRetargeted = false;
  let mutationCalls = 0;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => xcodeSelect(selectedDeveloper),
    resolveXcodePath: async (path) => {
      if (path === selectedDeveloper) {
        return `${selectedBundle}/Contents/Developer`;
      }
      if (path === selectedSpelling) {
        const resolved = selectedBundle;
        if (boundaryActive && !aliasRetargeted) {
          aliasRetargeted = true;
          selectedBundle = target;
        }
        return resolved;
      }
      return path;
    },
    listApplications: async () => [
      xcodeEntry("Xcode.app", "symlink"),
      xcodeEntry("Xcode_16.4.app"),
      xcodeEntry("Xcode_15.4.app"),
    ],
    validateXcodeRemoval: async () => {},
    removeXcodeTarget: async (
      _target,
      _allowedParents,
      _context,
      removalDependencies,
    ) => {
      const beforeMutation = removalDependencies?.beforeMutation;
      assert.ok(beforeMutation);
      boundaryActive = true;
      try {
        await beforeMutation("local", {
          exists: true,
          isLink: false,
          realPath: target,
          identity: { device: 1n, inode: 1n },
        });
      } catch (error) {
        return {
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      mutationCalls += 1;
      return { status: "removed" };
    },
  });
  const removal = (await adapter.operations(planFor("xcode"))).find(
    ({ id }) => id === "xcode:Xcode_15.4.app",
  );
  assert.ok(removal?.validate);
  await removal.validate();

  const result = await removal.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /Xcode selection changed/);
  assert.equal(aliasRetargeted, true);
  assert.equal(mutationCalls, 0);
});

for (const boundary of ["local", "elevated"] as const) {
  test(`macOS rechecks Xcode selection at the ${boundary} removal boundary`, async () => {
    const target = "/Applications/Xcode_15.4.app";
    let selectedDeveloper = SELECTED_DEVELOPER;
    let localMutationCalls = 0;
    let elevatedMutationCalls = 0;
    const adapter = await createMacOSAdapter(contextFor("macos"), {
      runXcodeSelect: async () => xcodeSelect(selectedDeveloper),
      resolveXcodePath: async (path) => path,
      listApplications: async () => [
        xcodeEntry("Xcode_16.4.app"),
        xcodeEntry("Xcode_15.4.app"),
      ],
      validateXcodeRemoval: async () => {},
      removeXcodeTarget: async (
        _target,
        _allowedParents,
        _context,
        removalDependencies,
      ) => {
        const beforeMutation = removalDependencies?.beforeMutation;
        if (beforeMutation === undefined) {
          localMutationCalls += 1;
          if (boundary === "elevated") elevatedMutationCalls += 1;
          return { status: "removed" };
        }
        const inspection = {
          exists: true,
          isLink: false,
          realPath: target,
          identity: { device: 1n, inode: 1n },
        } as const;
        try {
          if (boundary === "elevated") {
            await beforeMutation("local", inspection);
            localMutationCalls += 1;
          }
          selectedDeveloper = `${target}/Contents/Developer`;
          await beforeMutation(boundary, inspection);
        } catch (error) {
          return {
            status: "failed",
            detail: error instanceof Error ? error.message : String(error),
          };
        }
        if (boundary === "local") localMutationCalls += 1;
        else elevatedMutationCalls += 1;
        return { status: "removed" };
      },
    });
    const removal = (await adapter.operations(planFor("xcode"))).find(
      ({ id }) => id === "xcode:Xcode_15.4.app",
    );
    assert.ok(removal?.validate);
    await removal.validate();

    const result = await removal.run();

    assert.equal(result.status, "failed");
    assert.match(result.detail ?? "", /Xcode selection changed/);
    assert.equal(localMutationCalls, boundary === "elevated" ? 1 : 0);
    assert.equal(elevatedMutationCalls, 0);
  });
}

test("macOS rejects an Xcode target alias discovered at the removal boundary", async () => {
  const target = "/Applications/Xcode_15.4.app";
  let removalCalls = 0;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => xcodeSelect(SELECTED_DEVELOPER),
    resolveXcodePath: async (path) => path,
    listApplications: async () => [
      xcodeEntry("Xcode_16.4.app"),
      xcodeEntry("Xcode_15.4.app"),
    ],
    validateXcodeRemoval: async () => {},
    removeXcodeTarget: async (
      removalTarget,
      _allowedParents,
      _context,
      removalDependencies,
    ) => {
      assert.equal(removalTarget, target);
      const beforeMutation = removalDependencies?.beforeMutation;
      if (beforeMutation === undefined) {
        removalCalls += 1;
        return { status: "removed" };
      }
      try {
        await beforeMutation("local", {
          exists: true,
          isLink: false,
          realPath: SELECTED_XCODE,
          identity: { device: 1n, inode: 1n },
        });
      } catch (error) {
        return {
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      removalCalls += 1;
      return { status: "removed" };
    },
  });
  const removal = (await adapter.operations(planFor("xcode"))).find(
    ({ id }) => id === "xcode:Xcode_15.4.app",
  );
  assert.ok(removal?.validate);
  await removal.validate();

  const result = await removal.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /aliases the selected bundle/);
  assert.equal(removalCalls, 0);
});

test("macOS permits an unselected Xcode symlink at the removal boundary", async () => {
  const target = "/Applications/Xcode_15.4.app";
  let removalCalls = 0;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => xcodeSelect(SELECTED_DEVELOPER),
    resolveXcodePath: async (path) => path,
    listApplications: async () => [
      xcodeEntry("Xcode_16.4.app"),
      xcodeEntry("Xcode_15.4.app", "symlink"),
    ],
    validateXcodeRemoval: async () => {},
    removeXcodeTarget: async (
      removalTarget,
      _allowedParents,
      _context,
      removalDependencies,
    ) => {
      assert.equal(removalTarget, target);
      const beforeMutation = removalDependencies?.beforeMutation;
      assert.ok(beforeMutation);
      try {
        await beforeMutation("local", {
          exists: true,
          isLink: true,
          identity: { device: 1n, inode: 1n },
        });
      } catch (error) {
        return {
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
      removalCalls += 1;
      return { status: "removed" };
    },
  });
  const removal = (await adapter.operations(planFor("xcode"))).find(
    ({ id }) => id === "xcode:Xcode_15.4.app",
  );
  assert.ok(removal?.validate);
  await removal.validate();

  const result = await removal.run();

  assert.equal(result.status, "removed");
  assert.equal(removalCalls, 1);
});

test("macOS removes Xcode symlink aliases before their backing bundles", async () => {
  const backing = "/Applications/Xcode_15.4.app";
  const alias = "/Applications/Xcode_15.4.1.app";
  let backingRemoved = false;
  const removalOrder: string[] = [];
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => xcodeSelect(SELECTED_DEVELOPER),
    resolveXcodePath: async (path) => {
      if (path === alias) return backingRemoved ? undefined : backing;
      return path;
    },
    listApplications: async () => [
      xcodeEntry("Xcode_16.4.app"),
      xcodeEntry("Xcode_15.4.app"),
      xcodeEntry("Xcode_15.4.1.app", "symlink"),
    ],
    validateXcodeRemoval: async () => {},
    removeXcodeTarget: async (target) => {
      removalOrder.push(target);
      if (target === backing) backingRemoved = true;
      return { status: "removed" };
    },
  });
  const removals = (await adapter.operations(planFor("xcode"))).filter(
    ({ id }) => id !== "xcode:none",
  );
  for (const removal of removals) {
    assert.ok(removal.validate);
    await removal.validate();
  }

  const results = [];
  for (const removal of removals) results.push(await removal.run());

  assert.deepEqual(removalOrder, [alias, backing]);
  assert.deepEqual(
    results.map(({ status }) => status),
    ["removed", "removed"],
  );
});

test("macOS unlinks an already-broken unselected Xcode symlink", async () => {
  const target = "/Applications/Xcode_15.4.app";
  let removalCalls = 0;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => xcodeSelect(SELECTED_DEVELOPER),
    resolveXcodePath: async (path) => (path === target ? undefined : path),
    listApplications: async () => [
      xcodeEntry("Xcode_16.4.app"),
      xcodeEntry("Xcode_15.4.app", "symlink"),
    ],
    validateXcodeRemoval: async () => {},
    removeXcodeTarget: async (removalTarget) => {
      assert.equal(removalTarget, target);
      removalCalls += 1;
      return { status: "removed" };
    },
  });
  const removal = (await adapter.operations(planFor("xcode"))).find(
    ({ id }) => id === "xcode:Xcode_15.4.app",
  );
  assert.ok(removal?.validate);
  await removal.validate();

  const result = await removal.run();

  assert.equal(result.status, "removed");
  assert.equal(removalCalls, 1);
});

test("macOS rejects an ordinary target that becomes an alias of the selected bundle", async () => {
  const target = "/Applications/Xcode_15.4.app";
  let targetResolutions = 0;
  let removalCalls = 0;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => xcodeSelect(SELECTED_DEVELOPER),
    resolveXcodePath: async (path) =>
      path === target && ++targetResolutions >= 2 ? SELECTED_XCODE : path,
    listApplications: async () => [
      xcodeEntry("Xcode_16.4.app"),
      xcodeEntry("Xcode_15.4.app"),
    ],
    validateXcodeRemoval: async () => {},
    removeXcodeTarget: async () => {
      removalCalls += 1;
      return { status: "removed" };
    },
  });
  const removal = (await adapter.operations(planFor("xcode"))).find(
    ({ id }) => id === "xcode:Xcode_15.4.app",
  );
  assert.ok(removal?.validate);
  await removal.validate();

  const result = await removal.run();

  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /aliases the selected bundle/);
  assert.equal(removalCalls, 0);
});

test("macOS preserves a versioned Xcode alias resolving to the selected bundle", async () => {
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => xcodeSelect(SELECTED_DEVELOPER),
    resolveXcodePath: async (path) =>
      path === "/Applications/Xcode_15.4.app" ? SELECTED_XCODE : path,
    listApplications: async () => [
      xcodeEntry("Xcode_16.4.app"),
      xcodeEntry("Xcode_15.4.app", "symlink"),
      xcodeEntry("Xcode_14.3.app"),
    ],
    validateXcodeRemoval: async () => {},
    removeXcodeTarget: async () => ({ status: "removed" }),
  });

  assert.deepEqual(
    (await adapter.operations(planFor("xcode"))).map(({ id }) => id),
    ["xcode:Xcode_14.3.app"],
  );
});

test("macOS bounds Xcode selection-command failures and skips removal", async () => {
  let selectionCalls = 0;
  let removalCalls = 0;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    runXcodeSelect: async () => {
      selectionCalls += 1;
      if (selectionCalls < 7) return xcodeSelect(SELECTED_DEVELOPER);
      throw new Error("x".repeat(4_000));
    },
    resolveXcodePath: async (path) => path,
    listApplications: async () => [
      xcodeEntry("Xcode_16.4.app"),
      xcodeEntry("Xcode_15.4.app"),
    ],
    validateXcodeRemoval: async () => {},
    removeXcodeTarget: async () => {
      removalCalls += 1;
      return { status: "removed" };
    },
  });
  const removal = (await adapter.operations(planFor("xcode"))).find(
    ({ id }) => id === "xcode:Xcode_15.4.app",
  );
  assert.ok(removal?.validate);
  await removal.validate();

  const result = await removal.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /Unable to identify.*Xcode selection/);
  assert.ok((result.detail ?? "").length <= 2_000);
  assert.equal(removalCalls, 0);
});

for (const architecture of ["arm64", "x64"] as const) {
  test(`macOS ${architecture} accepts only its verified definition Homebrew executable`, async () => {
    const definition = BREW_PATHS[architecture];
    const calls: string[] = [];
    const probe: BrewPathProbe = {
      lstat: async (path) => {
        calls.push(`lstat:${path}`);
        if (path === definition.candidate) {
          return definition.candidateKind === "symlink"
            ? symlinkStats
            : fileStats;
        }
        if (path === definition.executable) return fileStats;
        throw new Error(`unexpected lstat: ${path}`);
      },
      realpath: async (path) => {
        calls.push(`realpath:${path}`);
        assert.equal(path, definition.candidate);
        return definition.executable;
      },
      access: async (path, mode) => {
        calls.push(`access:${path}:${mode}`);
        assert.equal(path, definition.executable);
        assert.equal(mode, constants.X_OK);
      },
    };

    assert.equal(
      await resolveDefinitionBrewExecutable(architecture, probe),
      definition.executable,
    );
    const expectedCalls = [
      `lstat:${definition.candidate}`,
      `realpath:${definition.candidate}`,
      `access:${definition.executable}:${constants.X_OK}`,
    ];
    if (definition.executable !== definition.candidate) {
      expectedCalls.splice(2, 0, `lstat:${definition.executable}`);
    }
    assert.deepEqual(calls, expectedCalls);
  });
}

test("macOS ignores workflow PATH and the other architecture's Homebrew candidate", async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = "/workflow/shims:/usr/local/bin";
  const inspected: string[] = [];
  const probe: BrewPathProbe = {
    lstat: async (path) => {
      inspected.push(path);
      // Model an attacker-provided Intel brew while the Apple Silicon
      // definition candidate is absent.
      if (path === BREW_PATHS.x64.candidate) return fileStats;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
    realpath: async () => {
      throw new Error("a missing definition candidate must not be resolved");
    },
    access: async () => {
      throw new Error("a PATH-selected executable must not be accessed");
    },
  };

  try {
    assert.equal(
      await resolveDefinitionBrewExecutable("arm64", probe),
      undefined,
    );
    assert.deepEqual(inspected, [BREW_PATHS.arm64.candidate]);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
  }
});

test("macOS rejects a fixed Homebrew link redirected outside its definition prefix", async () => {
  const definition = BREW_PATHS.x64;
  const inspected: string[] = [];
  const probe: BrewPathProbe = {
    lstat: async (path) => {
      inspected.push(`lstat:${path}`);
      assert.equal(path, definition.candidate);
      return symlinkStats;
    },
    realpath: async (path) => {
      inspected.push(`realpath:${path}`);
      return "/workflow/shims/brew";
    },
    access: async () => {
      throw new Error("a redirected Homebrew target must not be accessed");
    },
  };

  assert.equal(await resolveDefinitionBrewExecutable("x64", probe), undefined);
  assert.deepEqual(inspected, [
    `lstat:${definition.candidate}`,
    `realpath:${definition.candidate}`,
  ]);
});

test("macOS Homebrew commands use a trusted environment and preserve unknown packages", async () => {
  const configRoot =
    "/private/tmp/maximize-github-runner-space-homebrew-unit-test";
  const preflightEvents: string[] = [];
  const environmentNames = [
    "PATH",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "HOMEBREW_BREW_FILE",
    "HOMEBREW_PATH",
    "HOMEBREW_FORCE_BREW_WRAPPER",
    "HOMEBREW_RUBY_PATH",
    "HOMEBREW_GIT_PATH",
    "HOMEBREW_XDG_CONFIG_HOME",
    "RUBYOPT",
    "BASH_ENV",
    "ENV",
  ] as const;
  const original = new Map(
    environmentNames.map((name) => [name, process.env[name]]),
  );
  for (const name of environmentNames) {
    process.env[name] = `/workflow-controlled/${name.toLowerCase()}`;
  }

  const calls: {
    executable: string;
    args: readonly string[];
    environment: NodeJS.ProcessEnv;
    options: { readonly silent: boolean; readonly timeoutMs: number };
  }[] = [];
  const execute: MacOSBrewRunner = async (
    executable,
    args,
    environment,
    options,
  ) => {
    calls.push({
      executable,
      args: [...args],
      environment: { ...environment },
      options,
    });
    if (args.join(" ") === "list --formula --full-name") {
      return {
        exitCode: 0,
        stdout:
          "homebrew/core/gh\ngradle\nworkflow/tools/gh\nprivate/tools/gradle\nworkflow/tools/private-formula\n",
        stderr: "",
      };
    }
    if (args.join(" ") === "list --cask --full-name") {
      return {
        exitCode: 0,
        stdout:
          "google-chrome\nevil/browsers/google-chrome\nworkflow-private-cask\n",
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  try {
    const executable = BREW_PATHS.arm64.executable;
    const adapter = await createMacOSAdapter(contextFor("macos"), {
      resolveBrewExecutable: async (architecture) => {
        assert.equal(architecture, "arm64");
        return executable;
      },
      executeBrew: execute,
      inspectBrewConfig: async (path) => {
        preflightEvents.push(`inspect:${path}`);
        return undefined;
      },
      createBrewConfigRoot: async (prefix) => {
        assert.equal(
          prefix,
          "/private/tmp/maximize-github-runner-space-homebrew-",
        );
        preflightEvents.push("create");
        return configRoot;
      },
      validateBrewConfigRoot: async (path, requireEmpty) => {
        assert.equal(path, configRoot);
        preflightEvents.push(`validate:${requireEmpty}`);
      },
      removeBrewConfigRoot: async (path) => {
        assert.equal(path, configRoot);
        preflightEvents.push(`remove:${path}`);
      },
    });
    const operations = await adapter.operations(planFor("homebrew"));
    const configuration = operations.find(
      ({ id }) => id === "macos:brew:configuration",
    );
    const packages = operations.find(
      ({ id }) => id === "brew:definition-packages",
    );
    const cleanup = operations.find(({ id }) => id === "brew:cleanup:homebrew");
    assert.ok(configuration);
    assert.ok(configuration.validate);
    assert.equal(configuration.phase, "preflight");
    assert.equal(configuration.fatal, true);
    assert.deepEqual(preflightEvents, []);
    await configuration.validate();
    assert.deepEqual(preflightEvents, [
      "inspect:/etc/homebrew/brew.env",
      "inspect:/opt/homebrew/etc/homebrew/brew.env",
    ]);
    assert.equal((await configuration.run()).status, "removed");
    assert.deepEqual(preflightEvents, [
      "inspect:/etc/homebrew/brew.env",
      "inspect:/opt/homebrew/etc/homebrew/brew.env",
      "inspect:/etc/homebrew/brew.env",
      "inspect:/opt/homebrew/etc/homebrew/brew.env",
      "create",
      "validate:true",
    ]);
    assert.ok(packages);
    assert.ok(cleanup);
    assert.equal((await packages.run()).status, "removed");
    assert.equal((await cleanup.run()).status, "removed");
    assert.equal(
      preflightEvents.at(-1),
      `remove:${configRoot}`,
      "the final Homebrew operation must release its isolated configuration",
    );

    assert.deepEqual(
      calls.map(({ args }) => args),
      [
        ["list", "--formula", "--full-name"],
        ["list", "--cask", "--full-name"],
        ["uninstall", "--cask", "--force", "google-chrome"],
        [
          "uninstall",
          "--formula",
          "--force",
          "--ignore-dependencies",
          "homebrew/core/gh",
          "gradle",
        ],
        ["cleanup", "--prune=all", "-s"],
      ],
    );
    assert.equal(
      calls.some(({ args }) =>
        args.some((argument) => argument.includes("workflow")),
      ),
      false,
      "workflow-installed unknown packages must not be passed to uninstall",
    );
    assert.equal(
      calls.some(({ args }) =>
        args.some(
          (argument) =>
            argument === "workflow/tools/gh" ||
            argument === "private/tools/gradle" ||
            argument === "evil/browsers/google-chrome",
        ),
      ),
      false,
      "custom-tap basename collisions must remain outside definition ownership",
    );
    assert.equal(
      calls.some(({ args }) => args[0] === "autoremove"),
      false,
      "autoremove could claim an unknown workflow-installed dependency",
    );

    const expectedEnvironmentKeys = [
      "CI",
      "HOME",
      "HOMEBREW_NO_ANALYTICS",
      "HOMEBREW_NO_AUTOREMOVE",
      "HOMEBREW_NO_AUTO_UPDATE",
      "HOMEBREW_NO_ENV_HINTS",
      "LANG",
      "LOGNAME",
      "PATH",
      "SHELL",
      "TERM",
      "TMPDIR",
      "USER",
      "XDG_CONFIG_HOME",
    ];
    for (const call of calls) {
      assert.equal(call.executable, executable);
      assert.deepEqual(
        Object.keys(call.environment).sort(),
        expectedEnvironmentKeys,
      );
      assert.equal(call.environment.HOME, "/Users/runner");
      assert.equal(call.environment.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
      assert.equal(call.environment.TMPDIR, "/private/tmp");
      assert.equal(call.environment.XDG_CONFIG_HOME, configRoot);
      assert.equal(call.environment.HOMEBREW_BREW_FILE, undefined);
      assert.equal(call.environment.HOMEBREW_PATH, undefined);
      assert.equal(call.environment.HOMEBREW_FORCE_BREW_WRAPPER, undefined);
      assert.equal(call.environment.HOMEBREW_RUBY_PATH, undefined);
      assert.equal(call.environment.HOMEBREW_GIT_PATH, undefined);
      assert.equal(call.environment.HOMEBREW_XDG_CONFIG_HOME, undefined);
      assert.equal(call.environment.RUBYOPT, undefined);
      assert.equal(call.environment.BASH_ENV, undefined);
      assert.equal(call.environment.ENV, undefined);
    }
  } finally {
    for (const [name, value] of original) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("macOS Homebrew cleanup is a no-op when the fixed candidate is absent", async () => {
  let executed = false;
  let created = false;
  let removed = false;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => undefined,
    executeBrew: async () => {
      executed = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    inspectBrewConfig: async () => undefined,
    createBrewConfigRoot: async () => {
      created = true;
      throw new Error("absent Homebrew must not create a configuration root");
    },
    removeBrewConfigRoot: async () => {
      removed = true;
      throw new Error("absent Homebrew must not remove a configuration root");
    },
  });
  const operations = await adapter.operations(planFor("homebrew"));
  const homebrew = operations.filter(
    ({ component }) => component === "homebrew",
  );
  assert.equal(homebrew.length, 3);
  for (const operation of homebrew) {
    assert.equal((await operation.run()).status, "not-found");
  }
  assert.equal(executed, false);
  assert.equal(created, false);
  assert.equal(removed, false);
});

test("macOS releases its isolated configuration when Homebrew cleanup fails", async () => {
  const configRoot =
    "/private/tmp/maximize-github-runner-space-homebrew-cleanup-failure";
  const removed: string[] = [];
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => BREW_PATHS.arm64.executable,
    executeBrew: async (_executable, args, environment) => {
      assert.equal(environment.XDG_CONFIG_HOME, configRoot);
      assert.deepEqual(args, ["cleanup", "--prune=all", "-s"]);
      return { exitCode: 23, stdout: "", stderr: "simulated cleanup failure" };
    },
    inspectBrewConfig: async () => undefined,
    createBrewConfigRoot: async () => configRoot,
    validateBrewConfigRoot: async (path, requireEmpty) => {
      assert.equal(path, configRoot);
      assert.equal(typeof requireEmpty, "boolean");
    },
    removeBrewConfigRoot: async (path) => {
      removed.push(path);
    },
  });
  const operations = await adapter.operations(planFor("homebrew"));
  const configuration = operations.find(
    ({ id }) => id === "macos:brew:configuration",
  );
  const cleanup = operations.find(({ id }) => id === "brew:cleanup:homebrew");
  assert.ok(configuration?.validate);
  assert.ok(cleanup);
  await configuration.validate();
  assert.equal((await configuration.run()).status, "removed");
  const result = await cleanup.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /simulated cleanup failure/);
  assert.deepEqual(removed, [configRoot]);
});

test("macOS releases isolated Homebrew configuration when every package owner is protected", async () => {
  const configRoot =
    "/private/tmp/maximize-github-runner-space-homebrew-all-owners-protected";
  const commands: string[][] = [];
  const removed: string[] = [];
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => BREW_PATHS.arm64.executable,
    executeBrew: async (_executable, args, environment) => {
      assert.equal(environment.XDG_CONFIG_HOME, configRoot);
      commands.push([...args]);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    inspectBrewConfig: async () => undefined,
    createBrewConfigRoot: async () => configRoot,
    validateBrewConfigRoot: async (path) => {
      assert.equal(path, configRoot);
    },
    removeBrewConfigRoot: async (path) => {
      removed.push(path);
    },
  });
  const plan: CleanupPlan = {
    profile: "max",
    enabled: new Set<ComponentId>(["homebrew"]),
    skipped: new Set<ComponentId>(
      COMPONENTS.map(({ id }) => id).filter((id) => id !== "homebrew"),
    ),
    swapfileBytes: undefined,
  };
  const operations = await adapter.operations(plan);
  const configuration = operations.find(
    ({ id }) => id === "macos:brew:configuration",
  );
  const cleanup = operations.find(({ id }) => id === "brew:cleanup:homebrew");

  assert.ok(configuration?.validate);
  assert.ok(cleanup);
  assert.equal(
    operations.some(({ id }) => id === "brew:definition-packages"),
    false,
  );
  await configuration.validate();
  assert.equal((await configuration.run()).status, "removed");
  assert.equal((await cleanup.run()).status, "removed");
  assert.deepEqual(commands, [["cleanup", "--prune=all", "-s"]]);
  assert.deepEqual(removed, [configRoot]);
});

test("macOS Homebrew rejects fixed configuration files before any command", async () => {
  const config = "/opt/homebrew/etc/homebrew/brew.env";
  const observed: string[] = [];
  const inspectConfig: BrewConfigProbe = async (path) => {
    observed.push(path);
    return path === config ? fileStats : undefined;
  };
  let executed = false;
  let created = false;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => BREW_PATHS.arm64.executable,
    executeBrew: async () => {
      executed = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    inspectBrewConfig: inspectConfig,
    createBrewConfigRoot: async () => {
      created = true;
      throw new Error("rejected configuration must prevent directory creation");
    },
  });
  const operations = await adapter.operations(planFor("homebrew"));
  const configuration = operations.find(
    ({ id }) => id === "macos:brew:configuration",
  );
  assert.ok(configuration?.validate);
  await assert.rejects(
    async () => await configuration.validate?.(),
    /configuration can override cleanup paths/,
  );
  assert.equal(executed, false);
  assert.equal(created, false);
  assert.deepEqual(observed, [
    "/etc/homebrew/brew.env",
    "/opt/homebrew/etc/homebrew/brew.env",
  ]);
});

test("macOS Homebrew rechecks fixed configuration files before package mutation", async () => {
  const config = "/etc/homebrew/brew.env";
  let inspections = 0;
  let executed = false;
  let created = false;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => BREW_PATHS.arm64.executable,
    executeBrew: async () => {
      executed = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    inspectBrewConfig: async (path) => {
      if (path !== config) return undefined;
      inspections += 1;
      return inspections === 1 ? undefined : fileStats;
    },
    createBrewConfigRoot: async () => {
      created = true;
      throw new Error("failed recheck must prevent directory creation");
    },
  });
  const operations = await adapter.operations(planFor("homebrew"));
  const configuration = operations.find(
    ({ id }) => id === "macos:brew:configuration",
  );
  assert.ok(configuration?.validate);
  await configuration.validate();
  const result = await configuration.run();
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /configuration can override cleanup paths/);
  assert.equal(executed, false);
  assert.equal(created, false);
});

test("macOS Homebrew rejects an isolated configuration root outside its fixed temporary parent", async () => {
  let executed = false;
  const adapter = await createMacOSAdapter(contextFor("macos"), {
    resolveBrewExecutable: async () => BREW_PATHS.arm64.executable,
    executeBrew: async () => {
      executed = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    inspectBrewConfig: async () => undefined,
    createBrewConfigRoot: async () =>
      "/Users/runner/work/_temp/maximize-github-runner-space-homebrew-test",
  });
  const operations = await adapter.operations(planFor("homebrew"));
  const configuration = operations.find(
    ({ id }) => id === "macos:brew:configuration",
  );
  assert.ok(configuration?.validate);
  await configuration.validate();
  const result = await configuration.run();
  assert.equal(result.status, "failed");
  assert.match(
    result.detail ?? "",
    /Refusing unexpected Homebrew configuration directory/,
  );
  assert.equal(executed, false);
});

test("macOS validates isolated Homebrew configuration ownership, mode, and emptiness", async () => {
  const path =
    "/private/tmp/maximize-github-runner-space-homebrew-config-validation";
  const directoryStats = {
    isDirectory: () => true,
    isSymbolicLink: () => false,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    mode: 0o40700,
  };
  const validProbe: BrewConfigRootProbe = {
    lstat: async (observed) => {
      assert.equal(observed, path);
      return directoryStats;
    },
    readdir: async (observed) => {
      assert.equal(observed, path);
      return [];
    },
  };
  await validateDefinitionBrewConfigRoot(path, true, validProbe);

  await assert.rejects(
    validateDefinitionBrewConfigRoot(path, true, {
      ...validProbe,
      lstat: async () => ({ ...directoryStats, isSymbolicLink: () => true }),
    }),
    /non-directory/,
  );
  await assert.rejects(
    validateDefinitionBrewConfigRoot(path, true, {
      ...validProbe,
      lstat: async () => ({ ...directoryStats, uid: directoryStats.uid + 1 }),
    }),
    /unowned/,
  );
  await assert.rejects(
    validateDefinitionBrewConfigRoot(path, true, {
      ...validProbe,
      lstat: async () => ({ ...directoryStats, mode: 0o40755 }),
    }),
    /shared.*permissions/,
  );
  await assert.rejects(
    validateDefinitionBrewConfigRoot(path, true, {
      ...validProbe,
      readdir: async () => ["homebrew"],
    }),
    /non-empty/,
  );
});
