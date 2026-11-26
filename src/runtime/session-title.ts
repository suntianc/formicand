import type { SummaryCompletion } from "./session-summary.js";

/**
 * A short title for a new conversation, written by a model from its first
 * exchange.
 */

export const TITLE_SYSTEM_PROMPT =
  "You name conversations. Do not answer or continue the conversation. Output only the title.";

const TITLE_INSTRUCTIONS =
  "Write a title for the conversation above: what the user wants, in the language the user wrote in, at most 20 Chinese characters or 8 English words. No quotes, no trailing punctuation, no prefix such as Title.";

/** Each side of the exchange is cut to this many characters. */
const EXCHANGE_CHARS = 4_000;
const TITLE_CHARS = 60;
const TITLE_TIMEOUT_MS = 60_000;

export interface FirstExchange {
  user: string;
  assistant: string;
}

function cut(text: string): string {
  return text.length > EXCHANGE_CHARS ? `${text.slice(0, EXCHANGE_CHARS)}…` : text;
}

/** The title in a reply, or undefined when it holds none. */
export function extractTitle(reply: string): string | undefined {
  const line = reply
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .split("\n")
    .map((part) => part.trim())
    .find(Boolean);
  const title = line
    ?.replace(/^(title|标题)\s*[:：]\s*/i, "")
    .replace(/^["'“”‘’「」《》*#\s]+|["'“”‘’「」《》*\s。.!！?？]+$/g, "")
    .replace(/[\0-\x1f\x7f]/g, " ")
    .trim();
  return title ? title.slice(0, TITLE_CHARS) : undefined;
}

/** The title, or undefined when the model could not write one; the caller keeps the title it has. */
export async function writeSessionTitle(
  exchange: FirstExchange,
  complete: SummaryCompletion,
  signal?: AbortSignal
): Promise<string | undefined> {
  try {
    const timeout = AbortSignal.timeout(TITLE_TIMEOUT_MS);
    const reply = await complete(
      {
        systemPrompt: TITLE_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `<user>\n${cut(exchange.user)}\n</user>\n\n<assistant>\n${cut(exchange.assistant)}\n</assistant>\n\n${TITLE_INSTRUCTIONS}`
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
    const title = extractTitle(
      reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
    );
    if (!title) throw new Error("the reply held no title");
    return title;
  } catch (error) {
    console.warn(
      "[Formicand] The conversation keeps its title:",
      error instanceof Error ? error.message : String(error)
    );
  }
}
