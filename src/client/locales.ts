/**
 * Notification copy. Product-visible text lives in the locale registry rather
 * than at the call site, so the plugin follows the application language.
 */

/** Locale namespace this plugin owns. */
export const NS = 'dsh-notify'

/** Chinese copy. */
export const zh = {
  'notification.title': 'DeepSeek Harness',
  'notification.turnEnd': '「{title}」已完成',
  'notification.agentError': '「{title}」本轮运行失败',
  'notification.pendingInteraction': '「{title}」在等待你的确认',
  'notification.jobCompleted': '后台任务完成：{label}',
  'notification.jobFailed': '后台任务失败：{label}',
  'notification.jobKilled': '后台任务已取消：{label}',
  'notification.sessionFallback': '当前会话',
  'notification.selfTest': '通知已接通：任务结束、出错、后台任务结束或需要你确认时，都会像这样提醒你。',
}

/** English copy. */
export const en = {
  'notification.title': 'DeepSeek Harness',
  'notification.turnEnd': '"{title}" finished',
  'notification.agentError': '"{title}" failed this turn',
  'notification.pendingInteraction': '"{title}" is waiting for your confirmation',
  'notification.jobCompleted': 'Background job finished: {label}',
  'notification.jobFailed': 'Background job failed: {label}',
  'notification.jobKilled': 'Background job cancelled: {label}',
  'notification.sessionFallback': 'Current session',
  'notification.selfTest': 'Notifications are live: turns, errors, background jobs and confirmations will arrive like this.',
}
