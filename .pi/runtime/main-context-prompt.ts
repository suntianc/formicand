import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  MAIN_RUNTIME_CONTEXT_CLOSE,
  MAIN_RUNTIME_CONTEXT_OPEN,
  type MainContextState
} from "../../dist/src/runtime/main-context.js";
import { limitToolContent } from "../../dist/src/runtime/tool-output.js";

interface MainPromptState {
  runtime: MainContextState;
  goalAlreadyVisible?: boolean;
}

const MAX_MAIN_CONTEXT_CHARS = 12_000;

/** Current machine state is refreshed separately from the historical checkpoint. */
export function mainRuntimeContext(state: MainPromptState): string {
  const runtime = state.runtime;
  const parts = [
    "Current persisted Task context, added by the runtime to this request; the user did not write it. This snapshot does not establish that work or verification completed. Later user messages and explicit execution evidence update historical records.",
    `Runtime state: phase=${runtime.runtimePhase ?? "unknown"}; pending delegations=${runtime.runtimePendingDelegations ?? 0}.`,
    ...(runtime.runtimeGoal && !state.goalAlreadyVisible
      ? ["Task goal record (may be incomplete):", excerpt(runtime.runtimeGoal, 6_000)]
      : []),
    ...(runtime.runtimeLastEvent
      ? [
          `Last runtime event: ${excerpt(runtime.runtimeLastEvent.type, 80)}${runtime.runtimeLastEvent.summary ? ` — ${excerpt(runtime.runtimeLastEvent.summary, 240)}` : ""}`
        ]
      : []),
    "Use search_history and read_history for original conversation evidence."
  ];
  const open = MAIN_RUNTIME_CONTEXT_OPEN;
  const close = MAIN_RUNTIME_CONTEXT_CLOSE;
  return open + excerpt(parts.join("\n"), MAX_MAIN_CONTEXT_CHARS - open.length - close.length) + close;
}

/**
 * Add the current state to the newest message of this request only.
 *
 * The state changes between requests; anywhere before the newest message it
 * would rewrite the prefix the provider has cached. It is never recorded, so
 * the next request carries the newer state in its place and the conversation
 * the user sees does not hold it.
 */
export function withMainRuntimeContext(
  messages: readonly AgentMessage[],
  state: MainPromptState
): AgentMessage[] {
  const goal = state.runtime.runtimeGoal;
  const goalAlreadyVisible = Boolean(
    goal &&
    messages.some(
      (message) =>
        message.role === "compactionSummary" ||
        (message.role === "user" &&
          (typeof message.content === "string"
            ? message.content
            : message.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("\n")
          ).includes(goal))
    )
  );
  const context = mainRuntimeContext({ ...state, goalAlreadyVisible });
  const block = { type: "text" as const, text: context };
  const last = messages.at(-1);
  // Riding inside the newest user message or tool result keeps the roles the
  // model sees: a tool loop is not turned into a new user turn.
  if (last?.role === "user")
    return [
      ...messages.slice(0, -1),
      {
        ...last,
        content:
          typeof last.content === "string"
            ? [{ type: "text", text: last.content }, block]
            : [...last.content, block]
      }
    ];
  if (last?.role === "toolResult")
    return [...messages.slice(0, -1), { ...last, content: [...last.content, block] }];
  return [...messages, { role: "user", content: [block], timestamp: Date.now() }];
}

function excerpt(text: string, budget: number): string {
  // Keep delimiters inside user-owned goal text from becoming snapshot boundaries.
  const safe = text.replace(/<\/?formicand_main_context>/g, (tag) =>
    tag.replace("<", "&lt;").replace(">", "&gt;")
  );
  const [block] = limitToolContent([{ type: "text", text: safe }], budget);
  return block.type === "text" ? block.text : "";
}
