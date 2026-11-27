/**
 * Main's runtime adds the current Task state to the newest message of each
 * model request. A fake provider that reads the latest tool result or user
 * text takes it off first.
 */
export const withoutMainState = (text) =>
  text.replace(/\n?<formicand_main_context>\n[\s\S]*\n<\/formicand_main_context>$/, "");
