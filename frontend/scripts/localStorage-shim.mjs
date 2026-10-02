// 给 Node 注入最小 localStorage，供数据层冒烟脚本使用。
const map = new Map()
globalThis.localStorage = {
  getItem: (key) => (map.has(key) ? map.get(key) : null),
  setItem: (key, value) => map.set(key, String(value)),
  removeItem: (key) => map.delete(key),
  clear: () => map.clear(),
}
