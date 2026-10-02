export async function submitBatch(items, submit) {
  for (let index = 0; index < items.length; index += 1) {
    try {
      await submit(items[index]);
    } catch (err) {
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
        pendingItems: items.slice(index),
      });
    }
  }
}
