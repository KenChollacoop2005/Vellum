// Shared test helpers
import { test } from "node:test";
import assert from "node:assert/strict";
import { cases } from "../verify/cases.js";
import { runCase } from "../verify/run.js";

const SLOW = process.env.VELLUM_SLOW === "1";

export function testSheetCases(sheet) {
  for (const c of cases.filter((x) => x.sheet === sheet)) {
    test(`case ${c.id}: ${c.description}`, { skip: c.nodeSlow && !SLOW ? "slow case, run npm run test:slow" : false }, async () => {
      const res = await runCase(c);
      const bad = res.rows.filter((r) => !r.pass).map((r) => `${r.quantity}: expected ${JSON.stringify(r.expected)}, got ${r.computed}`);
      assert.equal(bad.length, 0, bad.join("\n"));
    });
  }
}
