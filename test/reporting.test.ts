import assert from "node:assert/strict";
import test from "node:test";
import { reportResults } from "../src/reporting.js";

test("operation reporting returns the same status counts that it logs", () => {
  assert.deepEqual(
    reportResults([
      { status: "removed" },
      { status: "removed", detail: "two" },
      { status: "not-found" },
      { status: "unsupported" },
      { status: "failed", detail: "bounded failure" },
    ]),
    {
      removed: 2,
      notFound: 1,
      unsupported: 1,
      failed: 1,
    },
  );
});
