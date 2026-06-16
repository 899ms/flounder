import assert from "node:assert/strict";
import test from "node:test";
import extension from "../dist/pi/extension.js";

test("pi extension registers agentic hunt tool", async () => {
  const tools = new Map();
  const handlers = new Map();
  const commands = new Map();
  const fakePi = {
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    on(event, handler) {
      handlers.set(event, handler);
    },
  };
  extension(fakePi);

  assert.ok(tools.has("fsa_run"));
  assert.ok(commands.has("fsa"));
  assert.ok(handlers.has("tool_call"));
  assert.ok(handlers.has("user_bash"));
});

test("pi extension blocks live-network exploit-like bash commands", async () => {
  const handlers = new Map();
  extension({
    registerTool() {},
    registerCommand() {},
    on(event, handler) {
      handlers.set(event, handler);
    },
  });

  const toolResult = await handlers.get("tool_call")({
    type: "tool_call",
    toolCallId: "1",
    toolName: "bash",
    input: { command: "zcash-cli -testnet sendrawtransaction poc" },
  });
  assert.equal(toolResult.block, true);

  const prodResult = await handlers.get("tool_call")({
    type: "tool_call",
    toolCallId: "2",
    toolName: "bash",
    input: { command: "chain-client --network production transfer --amount 1" },
  });
  assert.equal(prodResult.block, true);

  const userResult = await handlers.get("user_bash")({
    type: "user_bash",
    command: "run exploit on mainnet",
    excludeFromContext: false,
    cwd: process.cwd(),
  });
  assert.equal(userResult.result.exitCode, 2);
});
