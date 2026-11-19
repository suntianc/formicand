import { createInterface } from "node:readline";

/** A stdio MCP server with two tools, for settings and runtime tests. */
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize")
    reply(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "echo-fixture", version: "1" },
      instructions: "Echo text for tests"
    });
  else if (message.method === "tools/list")
    reply(message.id, {
      tools: [
        {
          name: "echo",
          description: "Echo the text back",
          inputSchema: { type: "object", properties: { text: { type: "string" } } }
        },
        { name: "erase", description: "Erase everything", inputSchema: { type: "object" } }
      ]
    });
  else if (message.method === "tools/call")
    reply(message.id, { content: [{ type: "text", text: `echo:${message.params.arguments.text ?? ""}` }] });
  else if (message.id !== undefined) reply(message.id, {});
});
