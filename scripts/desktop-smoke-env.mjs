import { join, win32 } from "node:path";

/** Keep the packaged smoke on its own data/model directories without changing the caller. */
export function desktopSmokeEnvironment({ data, source = process.env, platform = process.platform }) {
  const env = Object.fromEntries(
    Object.entries(source).filter(
      ([name]) =>
        !/^(?:FORMICAND_|PI_|WIN_CSC_|CSC_|APPLE_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_|AWS_|BEDROCK_|MISTRAL_|GROQ_|XAI_|CEREBRAS_|OPENROUTER_|TOGETHER_|DEEPSEEK_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/i.test(
          name
        ) &&
        !/_API_KEY$/i.test(name) &&
        name.toUpperCase() !== "PATH" &&
        name.toLowerCase() !== "npm_package_version"
    )
  );
  return {
    ...env,
    PATH:
      platform === "win32"
        ? [
            win32.join(source.SystemRoot || source.SYSTEMROOT || "C:\\Windows", "System32"),
            win32.join(
              source.SystemRoot || source.SYSTEMROOT || "C:\\Windows",
              "System32",
              "WindowsPowerShell",
              "v1.0"
            )
          ].join(";")
        : "/usr/bin:/bin",
    FORMICAND_DESKTOP_BACKGROUND: source.FORMICAND_DESKTOP_BACKGROUND ?? "1",
    FORMICAND_HOME: data,
    FORMICAND_DESKTOP_DATA: data,
    PI_CODING_AGENT_DIR: join(data, "pi"),
    FORMICAND_DISABLE_MAIN_GUARDIAN: "1",
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0"
  };
}
