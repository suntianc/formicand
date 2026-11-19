import { createInterface } from "node:readline";

/** A stdio MCP server with two tools, for settings and runtime tests; ECHO_RESOURCES=1 adds two resources. */
const resources = process.env.ECHO_RESOURCES === "1";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize")
    reply(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: resources ? { tools: {}, resources: {} } : { tools: {} },
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
  else if (message.method === "resources/list")
    reply(message.id, {
      resources: [
        { uri: "schema://public/tasks", name: "public.tasks", description: "Tasks table" },
        { uri: "ui://panel", name: "panel" }
      ]
    });
  else if (message.method === "resources/read")
    reply(message.id, { contents: [{ uri: message.params.uri, text: "create table tasks (id int)" }] });
  else if (message.id !== undefined) reply(message.id, {});
});
