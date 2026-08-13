import assert from "node:assert/strict";
import test from "node:test";
import { readActionInput } from "../src/inputs.js";
import { createPlan } from "../src/planner.js";

test("the action input boundary preserves exact custom-toggle strings", () => {
  const inputName = "remove-java";
  const environmentName = "INPUT_REMOVE-JAVA";
  const previous = process.env[environmentName];
  process.env[environmentName] = " true ";

  try {
    assert.equal(readActionInput(inputName), " true ");
    const plan = createPlan((name) =>
      name === "cleanup-profile" ? "custom" : readActionInput(name),
    );
    assert.equal(plan.enabled.has("java"), false);
  } finally {
    if (previous === undefined) {
      delete process.env[environmentName];
    } else {
      process.env[environmentName] = previous;
    }
  }
});
