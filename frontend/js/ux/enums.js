/** 展示用枚举镜像：只做按钮与文案映射，不参与错因/等级判定。
 *  判定唯一真源为 backend/tutor/enums.py；漂移由 tests/test_enum_single_source.py 拦截。 */

export const NEXT_ACTION = [
  "predict",
  "run",
  "compare",
  "locate_block",
  "replay",
  "edit_one",
  "open_next_task",
  "none",
];

export const NEXT_ACTION_LABEL = {
  predict: "先猜一猜",
  run: "运行看看",
  compare: "对照结果",
  locate_block: "找到这块积木",
  replay: "看看怎么走的",
  edit_one: "只改一处",
  open_next_task: "去下一关",
  none: "停在这里",
};

export const SUPPORT_LABEL = {
  none: "没有用提示",
  assisted: "用过提示",
  unknown: "无法判断",
};

export const TRANSFER_STATUS = ["not_started", "in_progress", "completed", "skipped"];

export const TRANSFER_STATUS_LABEL = {
  not_started: "还没开始",
  in_progress: "正在尝试",
  completed: "已经完成",
  skipped: "先跳过了",
};

export function nextActionLabel(value) {
  return NEXT_ACTION_LABEL[value] || NEXT_ACTION_LABEL.none;
}

export function supportLabel(value) {
  return SUPPORT_LABEL[value] || SUPPORT_LABEL.unknown;
}

export function transferStatusLabel(value) {
  return TRANSFER_STATUS_LABEL[value] || "还没开始";
}