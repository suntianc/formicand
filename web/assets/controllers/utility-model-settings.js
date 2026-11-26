import { ui } from "../ui/language.js";

/**
 * The host's model for context summaries and conversation titles.
 *
 * Empty follows each session's own model. The choices are the enabled models
 * of providers that have a key, the same ones a built-in Agent may pick.
 */
export function installUtilityModelSettings({ select, request, status, showToast, errorMessage }) {
  let busy = false;
  const option = (value, label) => {
    const element = document.createElement("option");
    element.value = value;
    element.textContent = label;
    return element;
  };
  const render = (snapshot) => {
    const chosen = snapshot.utilityModel ?? "";
    const groups = (snapshot.providers ?? [])
      .filter((provider) => provider.enabled && provider.configured && provider.models.length)
      .map((provider) => {
        const group = document.createElement("optgroup");
        group.label = provider.name;
        group.append(...provider.models.map((model) => option(model.profileId, model.name || model.id)));
        return group;
      });
    select.replaceChildren(option("", ui("跟随会话模型")), ...groups);
    // A model that is no longer offered still shows, so the page never claims another one.
    if (chosen && ![...select.options].some((entry) => entry.value === chosen))
      select.append(option(chosen, chosen));
    select.value = chosen;
  };
  const refresh = async () => {
    try {
      render(await status());
    } catch (error) {
      showToast(errorMessage(error));
    }
  };
  select.addEventListener("change", async () => {
    if (busy) return;
    busy = true;
    select.disabled = true;
    try {
      render(await request("POST", { profileId: select.value }, "/api/model-settings/utility"));
    } catch (error) {
      showToast(errorMessage(error));
      await refresh();
    } finally {
      busy = false;
      select.disabled = false;
    }
  });
  return { refresh };
}
