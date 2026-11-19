/**
 * Scripted Main replies that need a delegated result in the same turn.
 *
 * call_subagent always returns at once. A script step that marks its call with
 * `wait: true` gets the step after it only once the call has settled: in
 * between, this wrapper answers with wait_for_subagents for that callId (again
 * if a wait ends early), and the script then sees one tool result holding the
 * accepted record plus the settled status, response, output files and error.
 * The script's own step count does not include the waits.
 */

const TERMINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);
const SETTLED_STATUS = { completed: "succeeded" };

const messageText = (message) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? []).map((part) => part.text ?? "").join("");

/** The newest tool result and the name of the call it answers, in either wire format. */
function lastTool(body) {
  if (Array.isArray(body.input)) {
    const index = body.input.findLastIndex((item) => item.type === "function_call_output");
    if (index < 0) return undefined;
    const result = body.input[index];
    const call = body.input
      .slice(0, index)
      .findLast((item) => item.type === "function_call" && item.call_id === result.call_id);
    return { index, name: call?.name, text: typeof result.output === "string" ? result.output : "" };
  }
  const index = body.messages.findLastIndex((message) => message.role === "tool");
  if (index < 0) return undefined;
  const result = body.messages[index];
  const call = body.messages
    .slice(0, index)
    .flatMap((message) => message.tool_calls ?? [])
    .findLast((candidate) => candidate.id === result.tool_call_id);
  return { index, name: call?.function?.name, text: messageText(result) };
}

/** The same request with its newest tool result replaced by `text`. */
function withLastToolText(body, index, text) {
  if (Array.isArray(body.input)) {
    const input = body.input.slice();
    input[index] = { ...input[index], output: text };
    return { ...body, input };
  }
  const messages = body.messages.slice();
  messages[index] = { ...messages[index], content: text };
  return { ...body, messages };
}

/**
 * @param handle the script: (body, ...rest) => reply
 * @param isMain whether a request comes from Main; others pass through untouched
 */
export function waitForMarkedDelegations(handle, isMain) {
  let marked = false;
  let accepted;
  // Every script reply passes here, so a marked call is unmarked whichever step returned it.
  const run = async (body, rest) => {
    const reply = await handle(body, ...rest);
    if (reply?.name !== "call_subagent" || !reply.arguments?.wait) return reply;
    const { wait: _wait, ...args } = reply.arguments;
    marked = true;
    return { ...reply, arguments: args };
  };
  return async (body, ...rest) => {
    if (!isMain(body)) return handle(body, ...rest);
    const last = lastTool(body);
    if (marked && last?.name === "call_subagent") {
      marked = false;
      // A refused dispatch is an error text, not an accepted record: the script reads it as is.
      accepted = parsed(last.text);
      if (!accepted?.accepted) {
        accepted = undefined;
        return run(body, rest);
      }
      return wait(accepted.callId);
    }
    if (accepted && last?.name === "wait_for_subagents") {
      const call = JSON.parse(last.text).calls?.find((entry) => entry.callId === accepted.callId);
      // A callback Main already received as a message is not repeated by the
      // wait; its text is then in the transcript. The queue can also settle a
      // moment before the callback is written, so neither may be there yet.
      const delivered = callbackText(body, accepted.callId);
      const recorded = call?.response !== undefined || call?.error !== undefined || delivered;
      if (!call || !TERMINAL.has(call.status) || !recorded) return wait(accepted.callId);
      const settled = {
        ...accepted,
        status: SETTLED_STATUS[call.status] ?? call.status,
        response: call.response ?? delivered,
        outputFiles: call.outputFiles ?? [],
        ...(call.error ? { error: call.error } : {})
      };
      accepted = undefined;
      return run(withLastToolText(body, last.index, JSON.stringify(settled)), rest);
    }
    return run(body, rest);
  };
}

/** The text of a delivered callback message for this call, if Main has received one. */
function callbackText(body, callId) {
  const items = Array.isArray(body.input) ? body.input : body.messages;
  const text = (item) =>
    typeof item.content === "string"
      ? item.content
      : Array.isArray(item.content)
        ? item.content.map((part) => part.text ?? "").join("")
        : "";
  return items
    .filter((item) => item.role === "user")
    .map(text)
    .findLast((content) => content.includes(callId));
}

function parsed(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const wait = (callId) => ({
  name: "wait_for_subagents",
  arguments: { callIds: [callId], timeoutMs: 600_000 }
});
