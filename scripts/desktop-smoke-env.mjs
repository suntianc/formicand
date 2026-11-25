import { join } from "node:path";

/** Keep the packaged smoke on its own data/model directories without changing the caller. */
export function desktopSmokeEnvironment({ data, source = process.env }) {
  const env = Object.fromEntries(
    Object.entries(source).filter(
      ([name]) =>
        !/^(?:FORMICAND_|FORMICAND_|PI_|CSC_|APPLE_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_|AWS_|BEDROCK_|MISTRAL_|GROQ_|XAI_|CEREBRAS_|OPENROUTER_|TOGETHER_|DEEPSEEK_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/.test(
          name
        ) && !/_API_KEY$/.test(name)
    )
  );
  return {
    ...env,
    PATH: "/usr/bin:/bin",
    FORMICAND_DESKTOP_BACKGROUND: source.FORMICAND_DESKTOP_BACKGROUND ?? "1",
    FORMICAND_HOME: data,
    FORMICAND_DESKTOP_DATA: data,
    PI_CODING_AGENT_DIR: join(data, "pi"),
    FORMICAND_DISABLE_MAIN_GUARDIAN: "1",
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0"
  };
}
