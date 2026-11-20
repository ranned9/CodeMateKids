/** 端口连接判定纯函数：只按端口类型，不使用视觉坐标。 */

export const REASON_TEXT = {
  NEEDS_ACTION: "这里需要的是动作积木",
  NEEDS_VALUE: "这个位置需要一个数字或值",
  NOT_ALLOWED_HERE: "这个积木不能放在这里",
};

/**
 * @param {any} schema
 * @param {any} definition
 * @param {string} targetPortType
 */
export function canConnect(schema, definition, targetPortType) {
  if (!definition) {
    return { ok: false, reason: "NOT_ALLOWED_HERE", message: REASON_TEXT.NOT_ALLOWED_HERE };
  }
  const outputType = definition.outputType;
  const row = schema?.portRules?.[outputType] || {};
  if (row[targetPortType]) {
    return { ok: true, reason: null, message: "" };
  }
  if (targetPortType === "statement-next" || targetPortType === "statement-body") {
    return { ok: false, reason: "NEEDS_ACTION", message: REASON_TEXT.NEEDS_ACTION };
  }
  if (targetPortType === "expression") {
    return { ok: false, reason: "NEEDS_VALUE", message: REASON_TEXT.NEEDS_VALUE };
  }
  return { ok: false, reason: "NOT_ALLOWED_HERE", message: REASON_TEXT.NOT_ALLOWED_HERE };
}

export function canConnectToTarget(schema, definition, target, numberValue) {
  if (target.numberField) {
    if (definition?.kind !== "value.number") {
      return { ok: false, reason: "NEEDS_VALUE", message: "这个位置只接收数字积木。" };
    }
    const message = numberValue === undefined ? "" : numericFieldError(target.numberField, numberValue);
    if (message) {
      return { ok: false, reason: "INVALID_NUMBER", message };
    }
  }
  return canConnect(schema, definition, target.portType || portTypeOfTarget(target.id));
}

export function numericFieldError(field, value) {
  if (!Number.isFinite(value)) return "这个位置需要一个数字。";
  if (field.valueType === "integer" && !Number.isInteger(value)) return "这个位置需要一个整数。";
  if (field.choices && !field.choices.includes(value)) return `可以选择 ${field.choices.join("、")}。`;
  if (field.range?.min != null && value < field.range.min) return `数字不能小于 ${field.range.min}。`;
  if (field.range?.max != null && value > field.range.max) return `数字不能大于 ${field.range.max}。`;
  return "";
}

export function numberForNewBlock(field, defaultNumber, currentNumber) {
  if (!numericFieldError(field, defaultNumber)) return defaultNumber;
  return numericFieldError(field, currentNumber) ? field.defaultValue : currentNumber;
}
export function slotAccepts(slot) {
  if (slot.type === "slot") {
    return "expression";
  }
  if (slot.type === "body") {
    return "statement-body";
  }
  if (slot.type === "root") {
    return "statement-next";
  }
  return "statement-next";
}
/**
 * 目标引用到端口的唯一映射。
 * @param {string} ref
 */
export function portTypeOfTarget(ref) {
  if (typeof ref !== "string") {
    return null;
  }
  if (ref === "root" || ref.startsWith("root@") || ref.startsWith("stack:")) {
    return "statement-next";
  }
  if (ref.startsWith("body:")) {
    return "statement-body";
  }
  if (ref.startsWith("expr:")) {
    return "expression";
  }
  return null;
}
