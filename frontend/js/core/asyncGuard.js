/** 同一课堂内，每个任务共用进行中的跳过请求，失败后可重试。 */
export function createSkipRecorder(sendFeedback) {
  const requests = new Map();
  return (taskId) => {
    if (!requests.has(taskId)) {
      const request = Promise.resolve()
        .then(() => sendFeedback(taskId))
        .catch((error) => {
          requests.delete(taskId);
          throw error;
        });
      requests.set(taskId, request);
    }
    return requests.get(taskId);
  };
}
