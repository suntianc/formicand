/** Pages are numbered from 1. */
export function paginate(items, page = 1, size = 10) {
  const start = (page - 1) * size;
  return items.slice(start, start + size);
}

export const pageCount = (items, size = 10) => Math.max(1, Math.ceil(items.length / size));
