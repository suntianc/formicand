const orders = {
  id: (a, b) => a.id - b.id,
  title: (a, b) => a.itemTitle.localeCompare(b.itemTitle) || a.id - b.id
};

export function sortItems(items, by = "id") {
  const order = orders[by];
  if (!order) throw new Error(`unknown sort: ${by}`);
  return items.slice().sort(order);
}
