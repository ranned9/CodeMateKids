/** 学习总结三段：完成了什么、一个具体观察、一个小挑战；无证据时整段省略。 */

export function buildSummarySections(data = {}, facts = {}) {
  const completed = (data.completedTasks || []).join("、");
  const observation = data.observation || facts.observation || "";
  const challenge = data.nextStep || "下次换一种积木顺序，再试一次。";
  const sections = [
    {
      key: "done",
      title: "完成了什么",
      text: completed ? `完成了：${completed}。` : "这次还没有完成任务，可以回到课堂继续试。",
    },
  ];
  if (observation) {
    sections.push({ key: "observation", title: "一个具体观察", text: observation });
  }
  if (data.transfer) {
    const state = data.transfer;
    const title = state.title || "画正方形";
    const exercise = state.title ? `「${title}」` : title;
    const text = state.status === "completed"
      ? {
          none: state.title ? `这一次，你独立完成了${exercise}。` : "这一次，你在没有用提示的情况下画出了正方形。",
          assisted: `这一次，你在小老师的提示下完成了${exercise}。`,
        }[state.support] || `这次完成了${exercise}，提示使用情况没有完整记录。`
      : { skipped: `这次先跳过了${exercise}，随时可以回来。`, in_progress: `你已经开始尝试${exercise}。` }[state.status]
        || `可以试试${exercise}，先读一读任务目标。`;
    sections.push({ key: "transfer", title, text });
  }
  sections.push({ key: "challenge", title: "一个小挑战", text: challenge });
  return sections;
}

export function hasEvaluationLabel(sections = []) {
  return sections.some((section) => /分数|排名|等级|天才|笨蛋|优秀|差生/.test(section.text));
}
