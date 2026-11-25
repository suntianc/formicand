// Ant genera. Formica, the genus Formicand is named after, stays the product's own.
// Short, well-known genera come first.
const genera = [
  "Atta",
  "Lasius",
  "Messor",
  "Myrmica",
  "Camponotus",
  "Oecophylla",
  "Eciton",
  "Cataglyphis",
  "Pheidole",
  "Myrmecia",
  "Polyrhachis",
  "Tapinoma",
  "Solenopsis",
  "Tetramorium",
  "Temnothorax",
  "Aphaenogaster",
  "Crematogaster",
  "Pogonomyrmex",
  "Acromyrmex",
  "Dorylus",
  "Odontomachus",
  "Harpegnathos",
  "Gigantiops",
  "Daceton",
  "Cephalotes",
  "Dinoponera",
  "Paraponera",
  "Polyergus",
  "Myrmecocystus",
  "Iridomyrmex",
  "Linepithema",
  "Leptogenys",
  "Ectatomma",
  "Rhytidoponera",
  "Diacamma",
  "Neoponera",
  "Azteca",
  "Dolichoderus",
  "Liometopum",
  "Anoplolepis",
  "Nylanderia",
  "Prenolepis",
  "Plagiolepis",
  "Brachymyrmex",
  "Melophorus",
  "Opisthopsis",
  "Calomyrmex",
  "Echinopla",
  "Myrmoteras",
  "Pseudomyrmex",
  "Tetraponera",
  "Myrmecina",
  "Pristomyrmex",
  "Wasmannia",
  "Monomorium",
  "Cardiocondyla",
  "Carebara",
  "Cyphomyrmex",
  "Trachymyrmex",
  "Apterostigma",
  "Meranoplus",
  "Strumigenys",
  "Anochetus",
  "Amblyopone",
  "Proceratium",
  "Platythyrea",
  "Technomyrmex",
  "Ochetellus",
  "Forelius",
  "Dorymyrmex",
  "Neivamyrmex",
  "Aenictus"
];

/** A durable ID always has the same name, including in older task snapshots.
 * @param {string} agentId
 * @returns {string}
 */
export function agentDisplayName(agentId) {
  if (agentId === "main") return "Formicand";
  const number = /^subagent[_-](\d+)$/.exec(agentId)?.[1];
  const index =
    number && Number.isSafeInteger(Number(number))
      ? Math.max(0, Number(number) - 1)
      : [...agentId].reduce((hash, char) => (Math.imul(hash, 31) + char.codePointAt(0)) >>> 0, 0);
  // Letter designations keep names unique once every genus is used.
  let generation = Math.floor(index / genera.length);
  let designation = "";
  while (generation > 0) {
    designation = String.fromCharCode(65 + ((generation - 1) % 26)) + designation;
    generation = Math.floor((generation - 1) / 26);
  }
  return genera[index % genera.length] + (designation ? ` ${designation}` : "");
}

/** The display name of one agent, including names persisted by older snapshots.
 * @param {Record<string, any>} [agent]
 * @returns {string}
 */
export function agentName(agent = {}) {
  if (agent.__main || agent.agentId === "main") return "Formicand";
  if (/^subagent[_-]\d+$/.test(agent.agentId || "")) return agentDisplayName(agent.agentId);
  return agent.name || (agent.agentId ? agentDisplayName(agent.agentId) : "");
}
