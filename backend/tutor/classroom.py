"""工作区对话的教学策略与本地回复。"""

from __future__ import annotations

import re
from dataclasses import dataclass, replace


OBSERVATION_SIGNALS = ("confused_counts", "distinguished_counts")
HELP_LEVELS = {
    "conversation": 0,
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
    "control.if": "「如果」会比较海龟已经走过的步数。条件成立时，就执行里面的动作。",
    "control.else": "把「否则」接在「如果」下面。条件不成立时，就执行「否则」里的动作。",
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
    "control.if": r"如果积木|「如果」",
    "control.else": r"否则积木|「否则」",
    "motion.move": r"向前走|前进积木",
    "motion.turn": r"转个弯|转弯积木",
    "look.say": r"说句话|说话积木",
    "text.print": r"显示结果|打印积木",
    "value.number": r"数字积木|数值积木",
    "value.calc": r"运算积木|计算积木",
}
_SOCIAL_REPLIES = (
    (r"(?:(?:ai\s*)?小老师|老师)?[，, ]*(?:你好(?:呀|啊|哦)?|您好|哈[喽啰]|嗨|嘿|早上好|晚上好|"
     r"hi(?: there)?|hello|hey|good morning|good evening)(?:[，, ]*(?:老师|小老师))?", "你好呀！"),
    (r"(?:好[的呀]?[，, ]*)?(?:谢谢(?:你|老师|小老师)?|多谢|thanks(?: a lot)?|thank you)",
     "不客气，很高兴能帮上忙。"),
    (r"再见(?:啦|了)?|拜拜|bye|goodbye|下次见", "再见，下次聊！"),
    (r"对不起|抱歉|不好意思|sorry", "没关系。"),
    (r"你(?:是谁|叫什么(?:名字)?|能帮我什么)|who are you", "我是 AI 小老师，可以陪你聊聊，也能一起看积木。"),
    (r"你好吗|你怎么样|how are you(?: doing)?", "我在呢。你今天怎么样？"),
    (r"(?:我)?(?:能|可以)问(?:你)?(?:一下|个问题)(?:吗)?", "当然，直接问就好。"),
    (r"我(?:懂了|明白了|知道了|会了)(?:[，, ]*(?:谢谢(?:你|老师|小老师)?|多谢))?", "好呀！"),
    (r"(?:我)?(?:今天)?(?:有点|有些|好|很|太)?(?:累了?|难过|紧张|烦|不开心)(?:了|呀|啊)?",
     "听起来今天有点不容易。可以先歇一会儿，我在这儿。"),
    (r"(?:我)?(?:今天)?(?:很|好|真|挺|特别)?(?:开心|高兴|兴奋)(?:了|呀|啊|呢)?", "听你这么说，我也替你高兴。"),
)
_LESSON_WORDS = re.compile(
    r"积木|重复次数|循环|(?:向前|前进)|步数|几步|转弯|转个弯|海龟|正方形|"
    r"运行|程序|编程|预测|回放|画布|这题|题目|任务|卡住|没反应|没成功|做不出来|"
    r"给.{0,3}提示|怎么算|(?:哪|哪个|什么)数字|再举个例子"
)
_LESSON_FOLLOWUP = re.compile(
    r"^(?:这(?:里|块|个|样)|那个|它|现在|我(?:改|换|试)|帮我(?:看|改|试)|"
    r"说的是|我(?:指|说)的是|(?:前|后)面那个|(?:第[一二]|前|后)一个|"
    r"为什么|怎么|还是(?:没懂|不行|不对)|还(?:不行|不对)|改好了|可以了吗|换个说法|直接讲)"
)
_LESSON_ENTRY = re.compile(
    r"(?:我(?:该|应该)?[ ]*)?(?:从(?:哪一步|哪里|哪儿)开始|怎么(?:开始|做)|下一步(?:怎么做|做什么))[。！!？?]?"
)
_STEP_RESULT_QUESTION = re.compile(
    r"(?:怎么看|怎么知道|怎么判断|怎么确认|从哪(?:里|儿)?看|哪里看|是不是|是否|有没有)"
    r".{0,18}(?:走(?:了|过)?\s*(?:\d+|[零一二两三四五六七八九十百千]+|几|多少)\s*步|(?:实际|累计|总)?步数)"
    r"|走(?:了|过)?\s*(?:\d+|[零一二两三四五六七八九十百千]+)\s*步(?:了)?[吗么]"
)


@dataclass(frozen=True)
class Reply:
    message: str
    action: str
    target: str | None = None
    awaiting: bool = False


def _ask(message: str) -> Reply:
    return Reply(message, "ask_question", awaiting=True)


def social_reply(message: str) -> Reply | None:
    text = message.strip().rstrip("。！!？?，,~～.").strip().casefold()
    if re.fullmatch(r"(?:我(?:想|要|先)?|让我)(?:自己)?(?:先)?试(?:试|一下|一试)?[吧啦呀]*", text):
        return Reply("好，你先试试。需要时我就在这里。", "stop_guidance")
    for pattern, answer in _SOCIAL_REPLIES:
        if re.fullmatch(pattern, text):
            return Reply(answer, "conversation")
    return None


def is_lesson_turn(message: str, context: dict) -> bool:
    if (_LESSON_WORDS.search(message) or _STEP_RESULT_QUESTION.search(message)
            or _LESSON_ENTRY.fullmatch(message) or observation_signal(message)):
        return True
    previous = context["history"][-1] if context["history"] else {}
    if _LESSON_FOLLOWUP.search(message) and (
        context["selected_kind"] or context["run_id"]
        or previous.get("action") not in (None, "conversation", "stop_guidance")
    ):
        return True
    question = context["reply_to"] or previous
    return bool(
        question.get("awaitingAnswer") and question.get("action") != "conversation"
        and re.fullmatch(r"(?:是的?|不是|对|不对|前者|后者|[0-9一二两三四五六七八九十]+(?:次|步)?)[。！!？?]?", message)
    )


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


def _step_result_reply(facts: dict) -> Reply:
    actual = facts.get("actualSteps")
    target = facts.get("targetSteps")
    if type(actual) is not int:
        return Reply("这版积木运行完后，看右侧舞台下方的「累计走了 … 步」。那里会显示海龟实际走了几步。", "explain")

    message = f"看右侧舞台下方的「累计走了 {actual} 步」，这就是这次实际走过的步数。"
    if type(target) is int:
        if actual == target:
            message += "这个数字正好和目标步数一样。"
        else:
            difference = target - actual
            comparison = f"还差 {difference} 步" if difference > 0 else f"多走了 {-difference} 步"
            message += f"这题的目标是 {target} 步，这次{comparison}。"
    return Reply(message, "explain")


def local_reply(message: str, context: dict) -> Reply:
    reply = _teaching_reply(message, context)
    parts = re.split(r"[，,。！!]", message, maxsplit=1)
    opening = social_reply(parts[0]) if len(parts) == 2 and parts[1].strip() else None
    return replace(reply, message=opening.message + reply.message) if opening and opening.action == "conversation" else reply


def _teaching_reply(message: str, context: dict) -> Reply:
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

    if _STEP_RESULT_QUESTION.search(message):
        return _step_result_reply(facts)
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
    if _LESSON_ENTRY.fullmatch(message):
        return _contextual_hint(context, prior_question)
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

    if context.get("hint_ladder") and pattern in ("not_run", "unknown"):
        return _contextual_hint(context, prior_question)

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
    ladder = context.get("hint_ladder", [])
    if ladder:
        level = context["highest_hint"] + 1
        hint = next((hint for hint in reversed(ladder) if hint["level"] <= level), ladder[0])
        action = hint["action"]
        if action == "show_execution" and action in context["actions"]:
            return Reply(hint["promptText"], action, "verifiedReplay")
        if action not in ("explain", "hint", "analogy", "break_down", "partial_example"):
            action = "hint"
        return Reply(hint["promptText"], action)

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
