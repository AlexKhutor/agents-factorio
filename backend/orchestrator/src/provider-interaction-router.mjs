// One native method handler routes to exact threads; another bridge cannot
// replace the owner conversation's handler on the shared App Server client.
const clients = new WeakMap();
export function scopedInteractionClient(client, threadId) {
  let methods = clients.get(client);
  if (!methods) { methods = new Map(); clients.set(client, methods); }
  return {
    on: (...args) => client.on(...args),
    off: (...args) => client.off(...args),
    registerServerRequestHandler(method, handler) {
      let entry = methods.get(method);
      if (!entry) {
        entry = { threads: new Map(), dispose: null };
        entry.dispose = client.registerServerRequestHandler(method, (params, metadata) => {
          const target = entry.threads.get(params?.threadId);
          if (!target) throw Object.assign(new Error("Unbound interaction thread"), { code: "conflict" });
          return target(params, metadata);
        });
        methods.set(method, entry);
      }
      if (entry.threads.has(threadId)) throw Object.assign(new Error("Duplicate interaction thread"), { code: "conflict" });
      entry.threads.set(threadId, handler);
      return () => {
        if (entry.threads.get(threadId) !== handler) return;
        entry.threads.delete(threadId);
        if (entry.threads.size === 0) { entry.dispose(); methods.delete(method); }
      };
    },
  };
}
