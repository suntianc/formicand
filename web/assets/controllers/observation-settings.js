import { ui } from "../ui/language.js";
import { createSettingsPages } from "./settings-pages.js";
import { createSkillSettings } from "./skill-settings.js";
import { createMemorySettings } from "./memory-settings.js";
import { createAgentSettings } from "./agent-settings.js";
import { createMcpSettings } from "./mcp-settings.js";
import { createObserveData } from "./observe-data.js";
import { createObserveOverview } from "./observe-overview.js";
import { createObserveRuns } from "./observe-runs.js";
import { createObserveSidebar } from "./observe-sidebar.js";
import { createObserveRequirements } from "./observe-requirements.js";

export function createObservationSettings({
  $,
  api,
  management,
  storage,
  sessionStorage,
  isOnline,
  snapshot,
  visibleProjects,
  entryController,
  onModelChanged,
  beginNewConversation,
  showToast
}) {
  /**
   * The observation entry's read-only port.
   *
   * The local node is the page's existing client; every remote node gets one of
   * its own, stored per origin, so a token or failure never crosses nodes. The
   * work entry keeps using only the local client above.
   */
  const observeData = createObserveData({
    storage,
    sessionStorage,
    local: {
      origin: location.origin,
      name: ui("本机"),
      role: "internal",
      status: () => {
        // The same "online" flag the page's offline banner uses: a catalog read
        // that could not reach the backend means the local node is offline even
        // while the management client still reports its old session.
        if (!isOnline()) return "offline";
        const status = management.state().status;
        if (status === "connected") return "online";
        if (status === "connecting" || status === "idle") return "connecting";
        if (status === "unauthorized") return "unauthorized";
        return "offline";
      },
      snapshot,
      request: (path, options) => management.request(path, options)
    }
  });
  const settingsPages = createSettingsPages({
    root: $("#settings-entry"),
    app: $("#app-layout"),
    api,
    showToast,
    nodes: () => observeData.nodes(),
    members: () => [{ id: "self", name: ui("我"), owner: true }],
    addNode: (input) => observeData.addNode(input),
    renameNode: (origin, name) => observeData.renameNode(origin, name),
    reauthorizeNode: (origin) => observeData.reauthorizeNode(origin),
    reconnectNode: (origin) => observeData.reconnectNode(origin),
    disconnectNode: (origin) => observeData.disconnectNode(origin),
    removeNode: (origin) => observeData.removeNode(origin)
  });
  const agentSettings = createAgentSettings({
    panel: $('[data-settings-panel="agents"]'),
    api,
    projects: visibleProjects,
    onSection: settingsPages.onSection,
    showToast,
    // Main's model and effort are chosen here: the composer re-reads what the next turn uses.
    onBuiltinSaved: onModelChanged,
    // Main drafts the definition in a conversation and asks before it saves anything.
    askMain: () => {
      settingsPages.close();
      beginNewConversation();
      const input = $("#composer-input");
      input.value = ui("帮我创建一个 Agent：");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });
  function openAgentProposal(proposal) {
    agentSettings.openProposal(proposal);
    settingsPages.open("agents");
  }
  createSkillSettings({
    panel: $('[data-settings-panel="skills"]'),
    api,
    projects: visibleProjects,
    onSection: settingsPages.onSection,
    showToast
  });
  createMcpSettings({
    panel: $('[data-settings-panel="mcp"]'),
    api,
    onSection: settingsPages.onSection,
    showToast
  });
  createMemorySettings({
    panel: $('[data-settings-panel="memory"]'),
    api,
    projects: visibleProjects,
    onSection: settingsPages.onSection,
    showToast
  });
  const observeSidebar = createObserveSidebar({
    root: $(".observe-nav"),
    pane: $("#observe-entry"),
    data: observeData,
    addNode: () => settingsPages.addNodeDialog()
  });
  /**
   * The observation requirement view reads through the same port: the list, its
   * phase tabs and the detail are one read-only view of every connected node.
   */
  const observeRequirements = createObserveRequirements({
    pane: $("#observe-entry"),
    detail: $("#observe-detail"),
    layout: $(".app-layout"),
    data: observeData,
    showToast
  });
  observeRequirements.applyEntry(entryController.state());
  createObserveRuns({
    root: $('[data-observe-panel="runs"]'),
    header: $("[data-observe-runs-controls]"),
    data: observeData
  });
  const observeOverview = createObserveOverview({
    root: $('[data-observe-panel="overview"]'),
    data: observeData,
    onOpenView: (view) => entryController.setObserveView(view)
  });
  observeOverview.applyEntry(entryController.state());
  observeData.subscribe(() => {
    observeSidebar.render();
    settingsPages.refresh();
  });
  return {
    data: observeData,
    settingsPages,
    applyEntry(next) {
      observeOverview.applyEntry(next);
      observeRequirements.applyEntry(next);
    },
    openAgentProposal,
    dispose() {
      observeOverview.dispose();
      observeRequirements.dispose();
      observeData.dispose();
    }
  };
}
