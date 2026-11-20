import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import type { MainContextState } from "../../dist/src/runtime/main-context.js";
import { limitToolContent } from "../../dist/src/runtime/tool-output.js";

interface MainPromptState {
  runtime: MainContextState;
  goalAlreadyVisible?: boolean;
}

const MAX_MAIN_CONTEXT_CHARS = 12_000;
const CURRENT_STATE_BLOCK = /<atria_main_context>[\s\S]*?<\/atria_main_context>/g;

/** Current machine state is refreshed separately from the historical checkpoint. */
export function mainRuntimeContext(state: MainPromptState): string {
  const runtime = state.runtime;
  const parts = [
    "Current persisted Task context. This snapshot does not establish that work or verification completed. Later user messages and explicit execution evidence update historical records.",
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
  const open = "<atria_main_context>\n";
  const close = "\n</atria_main_context>";
  return open + excerpt(parts.join("\n"), MAX_MAIN_CONTEXT_CHARS - open.length - close.length) + close;
}

/** Replace one dynamic system section; never append snapshot messages to history. */
export function withMainRuntimeContext<T extends AgentMessage>(
  messages: readonly T[],
  state: MainPromptState
): T[] {
  const lastSystem = messages.findLastIndex((message) => message.role === "system");
  if (lastSystem < 0) return [...messages];
  const effective = getCurrentSystemMessage(messages.filter((message) => message.role === "system"));
  const workspace = effective?.sections?.current_workspace?.replace(CURRENT_STATE_BLOCK, "").trim() ?? "";
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
  return messages.map((message, index) => {
    if (message.role !== "system") return message;
    const current = message.sections?.current_workspace;
    if (index !== lastSystem && !current?.includes("<atria_main_context>")) return message;
    return {
      ...message,
      sections: {
        ...message.sections,
        current_workspace:
          index === lastSystem
            ? [workspace, context].filter(Boolean).join("\n\n")
            : (current?.replace(CURRENT_STATE_BLOCK, "").trim() ?? "")
      }
    };
  });
}

function excerpt(text: string, budget: number): string {
  // Keep delimiters inside user-owned goal text from becoming snapshot boundaries.
  const safe = text.replace(/<\/?atria_main_context>/g, (tag) =>
    tag.replace("<", "&lt;").replace(">", "&gt;")
  );
  const [block] = limitToolContent([{ type: "text", text: safe }], budget);
  return block.type === "text" ? block.text : "";
}
