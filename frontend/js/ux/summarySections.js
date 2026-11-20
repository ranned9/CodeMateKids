/** 学习总结三段：完成了什么、一个具体观察、一个小挑战；无证据时整段省略。 */

export function buildSummarySections(data = {}, facts = {}) {
  const completed = (data.completedTasks || []).join("、");
  const observation = facts.observation || data.observation || "";
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
  sections.push({ key: "challenge", title: "一个小挑战", text: challenge });
  return sections;
}

export function hasEvaluationLabel(sections = []) {
  return sections.some((section) => /分数|排名|等级|天才|笨蛋|优秀|差生/.test(section.text));
}
