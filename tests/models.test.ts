import { test } from "node:test";
import assert from "node:assert/strict";
import { toolsForModel, webTools } from "../lib/agent/claude";

test("Haiku gets the basic web tools; other models keep dynamic filtering", () => {
  const t = webTools(3, 2);
  const haiku = toolsForModel(t, "claude-haiku-5-5") as { type: string; max_uses: number }[];
  assert.deepEqual(haiku.map((x) => x.type), ["web_search_20250305", "web_fetch_20250910"]);
  assert.equal(haiku[0].max_uses, 3);
  assert.deepEqual(toolsForModel(t, "claude-sonnet-5-5"), t);
  const client = { name: "render_page", input_schema: {} };
  assert.deepEqual(toolsForModel([client], "claude-haiku-5-5"), [client]);
});
