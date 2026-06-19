import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MetadataStore } from "../dist/db/store.js";

// The dig re-upserts the FULL inventory after every scope. Re-stamping all of them made each
// audited scope show the same (latest) time instead of when IT finished, and there was no
// per-scope duration. This pins the fix: updated_at moves only on a real status change, and
// dig_seconds is persisted + COALESCE-kept.
test("upsertScopes: per-scope updated_at + dig_seconds survive inventory-wide re-upserts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fl-scope-"));
  const store = new MetadataStore(path.join(dir, "t.db"));
  const pid = store.upsertProject({ name: "p", sourcePaths: ["/x"], config: {} });

  store.upsertScopes(pid, [{ scopeId: "s1", status: "pending" }, { scopeId: "s2", status: "pending" }]);
  const t0 = store.listScopes(pid).find((s) => s.scope_id === "s1").updated_at;

  await new Promise((r) => setTimeout(r, 8));
  // dig finishes s1 (auditing -> audited, 42s) and re-upserts the whole inventory; s2 still pending
  store.upsertScopes(pid, [{ scopeId: "s1", status: "audited", digSeconds: 42 }, { scopeId: "s2", status: "pending" }]);
  let rows = store.listScopes(pid);
  const s1 = rows.find((s) => s.scope_id === "s1"), s2 = rows.find((s) => s.scope_id === "s2");
  assert.equal(s1.status, "audited");
  assert.equal(s1.dig_seconds, 42, "dig_seconds persisted");
  assert.notEqual(s1.updated_at, t0, "s1 updated_at advanced (its status changed)");
  assert.equal(s2.updated_at, t0, "s2 updated_at UNCHANGED — no re-stamp, so each scope keeps its own time");

  await new Promise((r) => setTimeout(r, 8));
  // a later inventory-wide upsert that omits dig_seconds must NOT wipe s1's recorded duration,
  // and must NOT bump s1's updated_at again (status unchanged)
  const t1 = s1.updated_at;
  store.upsertScopes(pid, [{ scopeId: "s1", status: "audited" }, { scopeId: "s2", status: "auditing" }]);
  rows = store.listScopes(pid);
  assert.equal(rows.find((s) => s.scope_id === "s1").dig_seconds, 42, "dig_seconds kept (COALESCE)");
  assert.equal(rows.find((s) => s.scope_id === "s1").updated_at, t1, "s1 updated_at still frozen at its audit time");
  assert.equal(rows.find((s) => s.scope_id === "s2").status, "auditing", "the in-progress scope is marked auditing");
  store.close();
});
