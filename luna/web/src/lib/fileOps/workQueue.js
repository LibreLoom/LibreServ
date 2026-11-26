/** A FIFO with a front slot for work that must retry before later entries. */
export function createWorkQueue() {
  let pending = [];
  let front = [];
  return {
    get length() { return pending.length + front.length; },
    push(entry) { pending.push(entry); },
    unshift(entry) { front.push(entry); },
    shift() {
      // Each entry moves to the front once. Popping also releases its slot.
      if (!front.length) {
        front = pending.reverse();
        pending = [];
      }
      return front.pop();
    },
  };
}
