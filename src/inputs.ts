import * as core from "@actions/core";

/** Preserve the historical composite action's raw string input semantics. */
export function readActionInput(name: string): string {
  return core.getInput(name, { trimWhitespace: false });
}
