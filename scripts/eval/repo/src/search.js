export function search(items, query) {
  const needle = query.toLowerCase();
  return items.filter(
    (item) => item.itemTitle.toLowerCase().includes(needle) || item.tags.some((tag) => tag === needle)
  );
}
