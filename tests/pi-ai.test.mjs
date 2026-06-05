import assert from "node:assert/strict";
import test from "node:test";
import { extractText, responseErrorMessage } from "../dist/llm/pi-ai.js";

test("pi-ai text extraction supports common provider response shapes", () => {
  assert.equal(extractText({ content: [{ text: "A" }, "B"] }), "AB");
  assert.equal(extractText({ output_text: "OK" }), "OK");
  assert.equal(extractText({ choices: [{ message: { content: "choice" } }] }), "choice");
  assert.equal(extractText({ output: [{ content: [{ text: "nested" }] }] }), "nested");
});

test("pi-ai error response detection surfaces provider failures", () => {
  assert.equal(responseErrorMessage({ stopReason: "error", errorMessage: "No API key for provider: openai" }), "No API key for provider: openai");
  assert.equal(responseErrorMessage({ error: { message: "quota exceeded" } }), "quota exceeded");
  assert.equal(responseErrorMessage({ stopReason: "stop" }), undefined);
});
