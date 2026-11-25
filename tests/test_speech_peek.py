"""ConversationStore.peek 只读查询：命中副本、只读性、TTL 过期与模式可用性。"""

from __future__ import annotations

import pytest

from backend.session.conversations import ConversationStore, TTL_SECONDS


def _seed(store: ConversationStore) -> dict:
    cached, history = store.begin(("s1", "key-1"), "turn-1", "fp-1", None)
    assert cached is None and history == []
    response = {"requestId": "r-1", "turnId": "turn-1", "message": "你好呀", "action": "hint", "awaitingAnswer": False}
    store.finish(("s1", "key-1"), "turn-1", "fp-1", "问", response, {"programDigest": "d1"})
    return response


def test_peek_returns_full_response_copy() -> None:
    store = ConversationStore()
    response = _seed(store)
    turn = store.peek(("s1", "key-1"), "turn-1")
    assert turn == response
    assert turn is not response
    turn["message"] = "篡改"
    assert store.peek(("s1", "key-1"), "turn-1") == response


def test_peek_missing_turn_returns_none() -> None:
    store = ConversationStore()
    _seed(store)
    assert store.peek(("s1", "key-1"), "turn-x") is None
    assert store.peek(("s2", "key-1"), "turn-1") is None
    assert store.peek(("s1", "key-2"), "turn-1") is None


def test_peek_is_readonly() -> None:
    clock = {"now": 100.0}
    store = ConversationStore(clock=lambda: clock["now"])
    _seed(store)
    before = store._scopes[("s1", "key-1")].touched
    turn_before = list(store._scopes[("s1", "key-1")].turns)
    assert store.peek(("s1", "key-1"), "turn-1") is not None
    clock["now"] += 60
    session = store._scopes[("s1", "key-1")]
    assert session.touched == before
    assert list(session.turns) == turn_before
    assert session.pending is None
    clock["now"] += TTL_SECONDS
    assert list(store._scopes) == [("s1", "key-1")]


def test_peek_expired_turn_returns_none_without_collecting() -> None:
    clock = {"now": 100.0}
    store = ConversationStore(clock=lambda: clock["now"])
    _seed(store)
    clock["now"] += TTL_SECONDS + 1
    assert store.peek(("s1", "key-1"), "turn-1") is None
    assert ("s1", "key-1") in store._scopes


def test_peek_works_in_non_classroom_mode() -> None:
    store = ConversationStore()
    _seed(store)
    assert store.peek(("s1", "key-1"), "turn-1") is not None


def test_peek_does_not_touch_pending_state() -> None:
    store = ConversationStore()
    _seed(store)
    store.begin(("s1", "key-1"), "turn-2", "fp-2", None)
    session = store._scopes[("s1", "key-1")]
    assert session.pending == "turn-2"
    store.peek(("s1", "key-1"), "turn-1")
    assert session.pending == "turn-2"
    store.abort(("s1", "key-1"), "turn-2")