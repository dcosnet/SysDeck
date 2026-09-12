export interface NavMatch {
  label: string;
  group: string;
}

/**
 * Filter nav items by a free-text query, matched case-insensitively against
 * the item label and its group name. An empty query returns every item.
 */
export function filterNav<T extends NavMatch>(items: T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return items;
  }
  return items.filter((item) =>
    item.label.toLowerCase().includes(needle) ||
    item.group.toLowerCase().includes(needle)
  );
}

/** Ordered list of the groups present in `items`, first-seen order. */
export function groupsOf<T extends NavMatch>(items: T[]): string[] {
  const groups: string[] = [];
  for (const item of items) {
    if (!groups.includes(item.group)) {
      groups.push(item.group);
    }
  }
  return groups;
}
