// 测试桩：注入最小 localStorage（esbuild define，在任何模块求值前生效）
globalThis.__memStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (globalThis.__memStore.has(k) ? globalThis.__memStore.get(k) : null),
  setItem: (k, v) => globalThis.__memStore.set(k, String(v)),
  removeItem: (k) => globalThis.__memStore.delete(k),
  clear: () => globalThis.__memStore.clear(),
};
