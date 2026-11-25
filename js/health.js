// 内核健康诊断：求值/状态失败时上报，绘画界面订阅并反馈，而不是静默吞掉。
export const health = {
  issues: [],
  listeners: new Set(),
  report(area, message, detail) {
    const issue = { at: Date.now(), area, message, detail: detail ?? null };
    this.issues.push(issue);
    if (this.issues.length > 50) this.issues.shift();
    for (const fn of this.listeners) {
      try {
        fn(issue);
      } catch {
        /* 监听器异常不影响内核 */
      }
    }
  },
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },
  clear() {
    this.issues.length = 0;
  },
};
