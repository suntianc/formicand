// Shared App/Web chrome. User content is never passed through this catalog.
import work from "./language-en-work.js";
import operations from "./language-en-operations.js";
import replies from "./language-en-replies.js";
import settings from "./language-en-settings.js";

export default {
  ...work,
  ...operations,
  ...replies,
  ...settings
};
