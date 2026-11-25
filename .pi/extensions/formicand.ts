import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerFormicandExtension from "../runtime/extension.ts";

/** Pi discovers this entry; feature registrations and runtime state live in separate modules. */
export default function formicand(pi: ExtensionAPI) {
  return registerFormicandExtension(pi);
}
