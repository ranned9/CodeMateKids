"""工作区对话的教学策略与本地回复。"""

from __future__ import annotations

import re
from dataclasses import dataclass


OBSERVATION_SIGNALS = ("confused_counts", "distinguished_counts")
HELP_LEVELS = {
    "ask_question": 0,
    "stop_guidance": 0,
    "hint": 1,
    "point_to_block": 1,
    "explain": 2,
    "show_execution": 2,
    "analogy": 2,
    "break_down": 3,
    "partial_example": 3,
    "edit_block": 2,
}

_BLOCK_EXPLANATIONS = {
    "control.repeat": "重复积木会把里面的动作再做几轮。放在它外面的动作只按外面的顺序执行。",
    "motion.move": "「向前走」让海龟朝当前方向走一步。",
    "motion.turn": "转弯积木改变海龟面向的方向。接下来的前进会朝新的方向走。",
    "event.start": "点击运行后，海龟会从开始积木接着往下做。",
    "value.number": "数字积木给旁边的指令提供一个数，例如重复次数或转弯角度。",
    "look.say": "「说句话」让海龟在舞台上说出你填的文字。",
    "text.print": "「显示结果」把插口里的值写到运行详情的输出区。",
    "value.calc": "运算积木会用选好的运算符计算两个数，把算出的值交给外面的积木。",
}
_BLOCK_NAMES = {
    "event.start": r"当开始|开始积木",
    "control.repeat": r"重复|循环",
    "motion.move": r"向前走|前进积木",
    "motion.turn": r"转个弯|转弯积木",
    "look.say": r"说句话|说话积木",
    "text.print": r"显示结果|打印积木",
    "value.number": r"数字积木|数值积木",
    "value.calc": r"运算积木|计算积木",
}


@dataclass(frozen=True)
class Reply:
    message: str
    action: str
    target: str | None = None
    awaiting: bool = False


def _ask(message: str) -> Reply:
    return Reply(message, "ask_question", awaiting=True)


def observation_signal(message: str) -> str | None:
    if re.search(r"每一步.{0,8}(算|是|当).{0,6}(一次|一回)|把.{0,6}步.{0,8}当成.{0,8}(次|移动)", message):
        return "confused_counts"
    if re.search(r"(一次前进|一次移动|一块前进).{0,10}(可以|能|会).{0,6}(几|多|两|好几)步", message):
        return "distinguished_counts"
    return None


def teaching_approach(observations: list[dict]) -> str | None:
    independent_tasks = set()
    correct_prediction = False
    recent_signal = None
    assisted = False
    for event in sorted(observations, key=lambda item: item["observedAt"], reverse=True):
        details = event["details"]
        if not independent_tasks and recent_signal is None and event["kind"] == "dialogue_signal":
            recent_signal = details["signal"]
        if event["kind"] != "run_result" or details["status"] != "completed":
            continue
        if details["outcome"] == "succeeded" and details["support"] == "none" and recent_signal != "confused_counts":
            independent_tasks.add(event["taskId"])
            correct_prediction |= details.get("predictionCorrect") is True
            if correct_prediction and len(independent_tasks) >= 2:
                return "independent"
        elif not independent_tasks:
            if details["pattern"] == "prediction_mismatch" and recent_signal is None:
                recent_signal = "confused_counts"
            assisted |= details["support"] == "assisted"
    if recent_signal == "confused_counts":
        return "check_counts"
    return "supported_practice" if assisted else None


def _count_reply(which: str, facts: dict) -> Reply:
    if which == "steps":
        actual = facts.get("actualSteps")
        prefix = f"这次海龟一共走了 {actual} 步。" if type(actual) is int else ""
        text = prefix + "总步数要把每一次前进走过的距离加起来。"
    else:
        moves = facts.get("moves")
        prefix = f"这次海龟前进了 {moves} 次。" if type(moves) is int else ""
        text = prefix + "每执行一次前进积木，就算一次前进。"
    return Reply(text, "explain")


def local_reply(message: str, context: dict) -> Reply:
    if not message:
        return _ask("我们可以聊当前的积木。你想一起看看哪一步？")
    if re.search(r"(我想|让我|我要|我先|我)[自己先]*试(试|一下|一试)?[吧啦。！]*$", message):
        return Reply("好，你先试试。需要时我就在这里。", "stop_guidance")

    history = context["history"]
    previous = context["reply_to"] or (history[-1] if history else {})
    facts = context["facts"]
    structure = context["structure"]
    selected = context["selected_kind"]
    controls = context["actions"]
    pattern = context["pattern"]
    signal = observation_signal(message)
    prior_question = previous.get("tutor", "")
    if previous.get("awaitingAnswer") and "前进次数" in prior_question and "总步数" in prior_question:
        if re.fullmatch(r"(后面|后一个|后者|第二个|后一项|总步数|后面那个)[。！!\s]*", message):
            return _count_reply("steps", facts)
        if re.fullmatch(r"(前面|前一个|前者|第一个|前一项|前进次数|前面那个)[。！!\s]*", message):
            return _count_reply("moves", facts)

    if re.search(r"差别|区别|为什么.{0,8}不一样|怎么.{0,8}不一样|比较|分别", message):
        if re.search(r"那个|这个|这里", message) and selected is None and (
            previous or (facts.get("moves") is not None and facts.get("actualSteps") is not None)
        ):
            return _ask("你想弄清前进次数，还是海龟一共走了几步，也就是总步数？")
        if type(facts.get("moves")) is int and type(facts.get("actualSteps")) is int:
            return Reply(
                f"这次前进了 {facts['moves']} 次，一共走了 {facts['actualSteps']} 步。"
                "前进次数数的是执行了几回前进积木，总步数数的是走过多少格。",
                "explain",
            )
        return Reply("前进次数数的是执行了几回前进积木。总步数数的是这些前进一共走了多远。", "explain")

    if signal == "confused_counts":
        if "show_execution" in controls:
            return Reply("我们回放看看。注意每一次前进开始和结束时，海龟在什么位置。",
                         "show_execution", "verifiedReplay")
        return _count_reply("moves", facts)
    if signal == "distinguished_counts":
        return _ask("你已经把动作次数和距离分开数了。试着预测一下这次会执行几回前进？")

    if re.search(r"这样|现在呢|改好了|可以了吗", message):
        if not context["program_valid"]:
            return _ask("当前的积木还有一处连接或参数问题。你刚才改的是哪块积木？")
        if structure.get("loop_body_has_move"):
            message = "现在前进积木已经放进重复积木里了。你猜它会执行几次？"
            if context["outcome"] == "goal_met":
                return Reply("这次运行达到目标了。你能说说循环里的动作是怎么重复的吗？",
                             "ask_question", awaiting=True)
            return _ask(message)
        if structure.get("outside_moves") and "outsideMoveBlock" in context["block_targets"]:
            return Reply("前进积木还在循环外。看看把它放进重复积木后，会发生什么。",
                         "point_to_block", "outsideMoveBlock")
        if previous:
            return _ask("接着看刚才那一步。你刚改了哪块积木？")

    if re.search(r"这题.{0,6}(做什么|目标|要求)|(?:任务|目标|题目).{0,4}(是什么|做什么|要求)", message):
        return Reply(context["objective"], "explain")
    if re.search(r"什么|干嘛|作用|怎么|如何|用法|解释", message):
        named = [kind for kind, names in _BLOCK_NAMES.items() if re.search(names, message)]
        if len(named) == 1:
            return Reply(_BLOCK_EXPLANATIONS[named[0]], "explain")
    if selected in _BLOCK_EXPLANATIONS and re.search(r"这|它|干嘛|意思|作用|数字|怎么|为什么", message):
        return Reply(_BLOCK_EXPLANATIONS[selected], "explain")
    if re.search(r"前进.{0,4}(几次|次数)|移动次数", message):
        return _count_reply("moves", facts)
    if re.search(r"一共.{0,4}步|总步数", message):
        return _count_reply("steps", facts)
    if re.search(r"例子|类比|换个说法", message):
        return Reply("想象跳格子。每执行一次「向前走」，海龟就走一格。重复就是多走几格。",
                     "analogy")
    if re.search(r"(没|不|没有)动|没反应", message):
        if not context["run_id"]:
            return _ask("你已经点过运行了，还是在猜它会怎么动？我们可以一起看看开始积木后面接了什么。")
        if facts.get("moves") == 0:
            return Reply("这次运行没有执行前进。可以看看前进积木有没有接到开始积木或循环里。", "hint")
        return _ask("你说的是点运行后的舞台，还是想问某块积木会做什么？")
    if re.fullmatch(r"(它|这|这个|这里|那个|为什么|怎么了|不对)[？?。\s]*", message) and selected is None:
        return _ask("你是想问哪块积木，还是刚才运行时海龟做了什么？")

    memory = context["memory"]
    direct = bool(re.search(r"直接讲|讲一下|解释|没懂|不懂", message))
    if memory == "check_counts" and pattern in ("not_run", "prediction_mismatch", "unknown"):
        if direct:
            return Reply("每执行一次「向前走」，海龟就走一步。数一数循环里会执行几次前进。", "explain")
        return _ask("每次前进走一步。你能从重复积木猜出海龟会走几步吗？")
    if memory == "independent" and pattern in ("not_run", "goal_met") and not direct:
        return _ask("你可以先用自己的方法预测，再用运行检查。你打算先核对哪个数字？")
    if memory == "supported_practice" and pattern == "not_run" and not direct:
        return _ask("上次你试出了结果。这次先看看哪组动作会反复执行，你猜会发生什么？")
    if pattern == "square_loop_structure":
        return Reply("海龟的路线已经走对了。再看看哪些动作可以放进同一个重复积木，一起反复做。", "explain")
    if pattern == "action_outside_loop" and context["block_targets"]:
        target = next(iter(context["block_targets"]))
        return Reply("看看循环里包含了哪些动作。试着找出应当一起重复的积木。",
                     "point_to_block", target)
    if context["repeated_pattern"] and context["highest_hint"] and "show_execution" in controls:
        return Reply("我们换个办法，回放一小段。注意海龟什么时候执行了前进、每次走了多远。",
                     "show_execution", "verifiedReplay")
    if direct:
        if context["goal_kind"] == "square":
            return Reply("每走完一条边就需要转弯。把前进和转弯放在同一个循环里，就能重复这一组动作。", "explain")
        return Reply("「向前走」每次走一步。重复积木上的数字决定这组动作做几回。", "explain")
    if pattern == "goal_met":
        return _ask("这次达到任务目标了。你能说说是哪组动作在重复吗？")
    if pattern == "program_invalid":
        return _ask("这组积木还有一处没接好或参数不合适。你现在想先看哪块？")
    return _contextual_hint(context, prior_question)


def _contextual_hint(context: dict, previous_text: str) -> Reply:
    candidates = []
    selected = _BLOCK_EXPLANATIONS.get(context["selected_kind"])
    if selected:
        candidates.append(Reply(selected, "explain"))
    if type(context["facts"].get("actualSteps")) is int:
        candidates.append(_count_reply("steps", context["facts"]))
    if context["structure"].get("loop_body_has_move") and "loopBlock" in context["block_targets"]:
        candidates.append(Reply("向前走已经放进循环。可以看看重复积木上的次数，数数它会执行几回。",
                                "point_to_block", "loopBlock"))
    candidates.append(Reply(context["objective"], "hint"))
    return next((reply for reply in candidates if reply.message != previous_text),
                _ask("点选一块你想了解的积木，我可以从它的作用讲起。"))
