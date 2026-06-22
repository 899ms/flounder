import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("default sandbox image includes baseline source-inspection tools", async () => {
  const dockerfile = await readFile(new URL("../docker/flounder-sandbox.Dockerfile", import.meta.url), "utf8");
  for (const pkg of ["bash", "cmake", "findutils", "grep", "jq", "git", "ninja-build", "ripgrep", "sed"]) {
    assert.match(dockerfile, new RegExp(`\\b${pkg}\\b`), `sandbox image should install ${pkg}`);
  }
});
