/**
 * Choose a built-in Agent's model the way the Agent page does, then answer
 * with the model settings, whose `modelRoles` show what each role resolves to.
 * An empty `profileId` clears the choice. A refused save is returned as is.
 */
export async function saveRoleModel(request, role, profileId, projectId) {
  const saved = await request("/api/agents/builtin", {
    target: projectId ? { scope: "project", projectId } : { scope: "global" },
    name: role,
    settings: profileId ? { profileId } : {}
  });
  if (saved.status !== 200) return saved;
  return request("/api/model-settings");
}
