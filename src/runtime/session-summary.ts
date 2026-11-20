import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { truncateToolText } from "./tool-output.js";

/**
 * The model-written part of a context window handoff.
 *
 * When a window is replaced, the model summarizes the conversation it is
 * leaving: requests, constraints, decisions, files, errors, what is done and
 * what comes next. The program keeps what records already hold exactly (the
 * user's own messages, the development record, outstanding work, the session
 * notes) and places them beside the summary, so the summary need not repeat
 * them. Modeled on Claude Code's compaction prompt and Codex's handoff.
 */

export const SUMMARY_SYSTEM_PROMPT =
  "You write the handoff summary for an agent whose context window is being replaced. Do not continue the conversation, answer its questions or call tools. Output only the analysis and the summary.";

export const SUMMARY_INSTRUCTIONS = `Write a handoff summary of the conversation above for the same agent, which continues the work in a new context window. Next to your summary it will see the user's messages verbatim, the development record, outstanding delegated work and questions, and its own session notes, so do not copy those; record what only the conversation shows.

First think it through in <analysis> tags: go through the conversation in order and note each request and correction from the user, what was done, the decisions and their reasons, the files involved, and the errors and how they were fixed. Check that nothing the next step depends on is missing.

Then write the summary in <summary> tags with these sections:
1. Requests and intent: everything the user asked for, in detail, including earlier requests that still apply.
2. Constraints and preferences: rules the user set and corrections they gave, in their own words where possible.
3. Decisions and findings: what was decided and why; facts learned about the code, data or environment.
4. Files and changes: files read or changed, what changed and why. Keep exact paths, names and commands.
5. Errors and fixes: what failed and how it was resolved, with the user's feedback on it.
6. Done: completed work.
7. In progress: the work under way when the window ended, precisely.
8. Next step: the next action, in line with the user's latest request. Quote the latest messages where it removes doubt. Omit this section when the work is finished.

Be concise. Keep exact identifiers, numbers and error messages.`;

/** The opening of a new window's first message: what it is and where the rest lives. */
export const HANDOFF_INTRO =
  "This session continues from an earlier context window. The summary below covers the earlier work; the full earlier conversation and tool results remain available through search_history and read_history. Continue from where the work stopped without redoing what is done.";

/** The summary block from the model's reply; the analysis is discarded. */
export function extractSummary(reply: string): string | undefined {
  const tagged = /<summary>([\s\S]*?)(?:<\/summary>|$)/.exec(reply)?.[1];
  const text = (tagged ?? reply.replace(/<analysis>[\s\S]*?(?:<\/analysis>|$)/g, "")).trim();
  return text || undefined;
}

/** The share of the window the conversation may take in the summary request; the rest is the reply. */
const SUMMARY_INPUT_SHARE = 0.6;
const SUMMARY_TIMEOUT_MS = 180_000;

/** One model request, answered with the model's whole reply. */
export type SummaryCompletion = (context: Context, signal: AbortSignal) => Promise<AssistantMessage>;

/**
 * The model's summary of the window being left, or undefined when it could
 * not be written. Conversation that does not fit the request keeps its start
 * and its latest part. A failure leaves the handoff to the records alone, so
 * changing windows never stalls on it.
 */
export async function writeHandoffSummary(
  /** The conversation as text, from Pi's serializer. */
  transcript: string,
  contextWindow: number,
  complete: SummaryCompletion,
  signal?: AbortSignal
): Promise<string | undefined> {
  try {
    // About four characters to a token, as Pi's own estimate.
    const conversation = truncateToolText(transcript, Math.floor(contextWindow * SUMMARY_INPUT_SHARE * 4));
    const timeout = AbortSignal.timeout(SUMMARY_TIMEOUT_MS);
    const reply = await complete(
      {
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `<conversation>\n${conversation}\n</conversation>\n\n${SUMMARY_INSTRUCTIONS}`
              }
            ],
            timestamp: Date.now()
          }
        ]
      },
      signal ? AbortSignal.any([signal, timeout]) : timeout
    );
    if (reply.stopReason === "error" || reply.stopReason === "aborted")
      throw new Error(reply.errorMessage || `the request ended with ${reply.stopReason}`);
    if (reply.content.some((block) => block.type === "toolCall")) throw new Error("the model called a tool");
    const summary = extractSummary(
      reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
    );
    if (!summary) throw new Error("the reply held no summary");
    return summary;
  } catch (error) {
    console.warn(
      "[CoworkOS] The context handoff has no summary:",
      error instanceof Error ? error.message : String(error)
    );
  }
}
