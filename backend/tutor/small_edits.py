"""生成一次可撤销的数值调整，使用已验证的程序和课堂运行。"""

from __future__ import annotations

import re

from backend.domain.program import number_input_value, program_roots
from backend.tutor.classroom import Reply


_FIELDS = {
    "times": ("control.repeat", "重复次数", "次", "它决定循环里的动作会做几轮。"),
    "steps": ("motion.move", "每次前进的步数", "步", "它决定执行这块前进积木时走多远。"),
    "degrees": ("motion.turn", "转弯角度", "°", "它决定执行这块积木时转多少度。"),
}
_NUMBER = r"\d{1,3}|[零一二两三四五六七八九十百]{1,3}"
_EDIT_REQUEST = re.compile(
    rf"(?:请)?(?:帮我|替我|你帮我)?(?:把|将)(?P<target>[^，。？！,!?]{{1,32}}?)"
    rf"(?:改成|调成|改为|调到|设为|设置为|设成)\s*(?P<value>{_NUMBER})"
    r"\s*(?P<unit>次|步|度|°)?(?:吧|好吗|可以吗)?[。！!？?]?"
)
_STUCK = re.compile(
    r"(?:(?:我|这里|这一步)?(?:又)?卡住了?|我不知道怎么改|"
    r"(?:试了.{0,8}[，,]?)?(?:还是?|一直)(?:不行|不对|没成功|做不出来))"
    r"(?:[，, ]*(?:能)?(?:帮我|带我)(?:改一步|改这步|改一下|试一步)(?:吗)?)?[。！!？?]?"
    r"|(?:请)?(?:帮我|带我)(?:改一步|改这步|改一下)(?:吧|好吗|可以吗)?[。！!？?]?"
)


def snapshot_blocks(program):
    """Traverse statements and values only after the caller validates the snapshot."""
    nodes = program_roots(program)
    while nodes:
        block = nodes.pop()
        yield block
        nodes.extend(block.get("body", []))
        nodes.extend(value for value in block.get("inputs", {}).values() if isinstance(value, dict))
        if block.get("next"):
            nodes.append(block["next"])


def plan_small_edit(message, context, program, selected_id, registry):
    requested = _EDIT_REQUEST.fullmatch(message)
    if not requested and not _STUCK.fullmatch(message):
        return None, None
    if not context["program_digest"]:
        return Reply("我先看看现在的积木。你卡在哪一块？", "ask_question", awaiting=True), None

    blocks = {block["blockId"]: block for block in snapshot_blocks(program)}
    if requested:
        field, block = _requested_field(requested["target"], requested["unit"], blocks, selected_id)
        value = _integer(requested["value"])
        if block is None or field is None:
            return Reply("你想改哪块积木的数字？可以先选中它，再说要改成多少。",
                         "ask_question", awaiting=True), None
    else:
        candidate = _diagnosed_change(context)
        if candidate is None:
            text = ("你是卡在重复次数、每次走几步，还是积木怎么接？" if context["run_id"]
                    else "先运行一次，让我看看海龟做了什么。你也可以选中一块积木，说说想改哪个数字。")
            return Reply(text, "ask_question", awaiting=True), None
        field, block_id, value = candidate
        block = blocks[block_id]

    _, label, unit, explanation = _FIELDS[field]
    definition = registry.get(block["kind"]).field(field)
    previous = number_input_value(block["inputs"].get(field))
    if not _allowed(definition, value) or type(previous) is not int:
        return Reply("这个数字不适合这里。打开积木上的数字，能看到可用的范围或选项。", "explain"), None
    if previous == value:
        return Reply(f"{label}已经是 {value} {unit}。你可以运行看看它的效果。", "explain"), None

    facts = context["facts"]
    edit = {
        "blockId": block["blockId"], "field": field, "before": previous, "after": value,
        "previousSteps": facts.get("actualSteps"), "previousMoves": facts.get("moves"),
    }
    reply = Reply(
        f"先把{label}从 {previous} {unit} 调到 {value} {unit}。{explanation}运行一次，看看结果有什么变化。",
        "edit_block",
    )
    return reply, edit


def _requested_field(target, unit, blocks, selected_id):
    if re.search(r"全部|所有|两块|每[一块个]", target):
        return None, None
    selected = blocks.get(selected_id)
    if selected and selected["kind"] == "value.number":
        selected = next(
            (block for block in blocks.values() for key in _FIELDS
             if block["kind"] == _FIELDS[key][0] and block["inputs"].get(key) is selected),
            None,
        )
    selected_field = next((key for key, spec in _FIELDS.items() if selected and selected["kind"] == spec[0]), None)
    named_fields = [key for key, token in (("times", "次数"), ("steps", "步数"), ("degrees", "角度"))
                    if token in target]
    if len(named_fields) > 1:
        return None, None
    name = named_fields[0] if named_fields else None
    if name is None:
        name = next((key for key, words in (("times", ("重复", "循环")), ("steps", ("前进", "向前走")),
                                           ("degrees", ("转弯", "转个弯"))) if any(word in target for word in words)), None)
    referring_to_selection = any(word in target for word in ("这块", "这个", "这里", "它"))
    field = name or (selected_field if referring_to_selection else None)
    if field is None or (unit and _FIELDS[field][2] != unit.replace("度", "°")):
        return None, None
    if referring_to_selection:
        return (field, selected) if selected_field == field else (None, None)
    if selected_field == field:
        return field, selected
    candidates = [block for block in blocks.values() if block["kind"] == _FIELDS[field][0]]
    return field, candidates[0] if len(candidates) == 1 else None


def _integer(text):
    if text.isdecimal():
        return int(text)
    digits = {name: i for i, name in enumerate("零一二三四五六七八九")}
    text = text.replace("两", "二")
    if text == "一百":
        return 100
    if "十" in text and text.count("十") == 1:
        high, low = text.split("十")
        if high in (*digits, "") and low in (*digits, ""):
            return 10 * digits.get(high, 1) + digits.get(low, 0)
    return digits.get(text)


def _allowed(field, value):
    if field is None or type(value) is not int:
        return False
    bounds = field.get("range", {})
    return (
        ("min" not in bounds or value >= bounds["min"])
        and ("max" not in bounds or value <= bounds["max"])
        and ("choices" not in field or value in field["choices"])
    )


def _diagnosed_change(context):
    structure = context["structure"]
    if context["last_run_status"] != "completed" or not structure.get("simple_move_loop"):
        return None
    facts = context["facts"]
    target = facts.get("targetSteps")
    times = structure.get("repeat_times")
    steps = structure.get("steps_per_move")
    if not all(type(number) is int and number > 0 for number in (target, times, steps)):
        return None
    if facts.get("actualSteps") != times * steps or facts.get("moves") != times:
        return None
    pattern = context["pattern"]
    if pattern == "loop_count_mismatch" and target % steps == 0 and structure.get("loop_id"):
        return "times", structure["loop_id"], target // steps
    if pattern == "move_steps_mismatch" and target % times == 0 and structure.get("move_id"):
        return "steps", structure["move_id"], target // times
    return None
