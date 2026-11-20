import { Type } from "typebox";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { CuaScriptController, type CuaScriptDispatcher } from "../../../dist/src/tools/cua-script.js";

export function registerCuaScriptTools(
  pi: ExtensionAPI,
  dispatcher: (
    name: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    ctx: ExtensionToolContext
  ) => ReturnType<CuaScriptDispatcher>
) {
  const controller = new CuaScriptController();
  pi.registerTool({
    name: "cua_script",
    label: "CUA JavaScript",
    description:
      "Run a bounded async JavaScript cell in isolated QuickJS against the active CUA tools. Keep bindings on state (state.win = await cua.computer.select({pid, windowId, mode}); state.tab = await cua.browser.open(url)); local let/const do not persist. Await every operation. Tabs offer getByRole/Label/Text/TestId locators, nth, frame, and clickAt/drag/scroll with fresh screenshot ids. wait/waitFor reject on timeout unless allowTimeout:true. No shell, filesystem, Node or network APIs; limits are 64 MiB, 64 calls, 15 s by default and 60 s at most. An error, cancellation or reset discards state and never retries input: check dispatchStatus, and do not repeat a sent or unknown action automatically. Returns call summaries and the last four images.",
    parameters: Type.Object(
      {
        code: Type.String({ maxLength: 65536 }),
        timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 60000 }))
      },
      { additionalProperties: false }
    ),
    async execute(_id, params, signal, _update, ctx) {
      return controller.execute(
        params,
        (name, body, innerSignal) => dispatcher(name, body, innerSignal, ctx),
        signal
      );
    }
  });
  pi.registerTool({
    name: "cua_reset",
    label: "Reset CUA JavaScript",
    description:
      "Cancel the current CUA cell and discard persistent JavaScript state and pending callbacks. Does not restore human desktop authorization or reset backend browser/desktop ownership. Rebind live windows/tabs before continuing.",
    parameters: Type.Object({}),
    async execute() {
      await controller.reset();
      const details = { vmReset: true };
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    }
  });
  return controller;
}
