from __future__ import annotations

from ag_ui.core import RunAgentInput, TextInputContent, ToolMessage, UserMessage
from agent_py.adapter import ChatroomAdapter, with_note
from agent_py.model import resolve_model
from agent_py.place import workspace_note


def run_input(**fields) -> RunAgentInput:
    base = {"thread_id": "t", "run_id": "r", "state": {}, "messages": [], "tools": [], "context": [], "forwarded_props": {}}
    return RunAgentInput.model_validate({**base, **fields})


def test_no_note_without_context():
    assert workspace_note(run_input()) == ""


def test_the_note_keeps_the_apps_json_compact():
    note = workspace_note(
        run_input(
            context=[
                {"description": "currentNode", "value": '{\n  "id": "n1",\n  "name": "Etch"\n}'},
                {"description": "selection", "value": "not json"},
            ],
            state={"todos": []},
        )
    )
    assert note == (
        "<workspace>\n"
        'currentNode\n{"id": "n1", "name": "Etch"}\n\n'
        "selection\nnot json\n\n"
        'Shared state (current):\n{"todos": []}\n'
        "</workspace>"
    )


def test_local_storage_is_named():
    note = workspace_note(run_input(forwarded_props={"knowledge_chatroom": {"storage": "local"}}))
    assert "browser's workspace file tools" in note


def test_the_note_goes_in_front_of_text_and_parts():
    assert with_note(UserMessage(id="m", content="hi"), "N").content == "N\n\nhi"
    parts = with_note(UserMessage(id="m", content=[TextInputContent(text="hi")]), "N").content
    assert [p.text for p in parts] == ["N", "hi"]


def test_resolve_model():
    assert resolve_model({}) == "claude-sonnet-5"
    assert resolve_model({"ANTHROPIC_MODEL": "claude-opus-4.6"}) == "claude-opus-4-6"
    assert resolve_model({"CLAUDE_MODEL": "a/claude-x.1", "ANTHROPIC_MODEL": "b"}) == "a/claude-x.1"


def test_the_note_goes_after_a_tools_result():
    result = with_note(ToolMessage(id="t", tool_call_id="c", content='{"ok": true}'), "N")
    assert result.content == '{"ok": true}\n\nN'


def continuation(context: str, *results: str) -> RunAgentInput:
    """A run that goes on after the browser ran openRun (or several tools)."""
    calls = [{"id": f"c{i}", "type": "function", "function": {"name": "openRun", "arguments": "{}"}} for i, _ in enumerate(results)]
    return run_input(
        messages=[
            {"id": "u", "role": "user", "content": "open run 2"},
            {"id": "a", "role": "assistant", "toolCalls": calls},
            *({"id": f"t{i}", "role": "tool", "toolCallId": f"c{i}", "content": r} for i, r in enumerate(results)),
        ],
        context=[{"description": "currentExperiment", "value": context}],
    )


def test_a_tool_continuation_carries_the_changed_note():
    adapter = ChatroomAdapter(name="t")
    prepared = adapter.prepare(continuation('{"title": "Run 2"}', '{"ok": true}'))
    assert prepared.messages[-1].content.startswith('{"ok": true}\n\n<workspace>')
    assert "Run 2" in prepared.messages[-1].content
    assert prepared.messages[0].content == "open run 2"


def test_earlier_tool_results_are_left_as_the_session_saw_them():
    adapter = ChatroomAdapter(name="t")
    prepared = adapter.prepare(continuation('{"title": "Run 2"}', "first", "second"))
    assert [m.content for m in prepared.messages[-2:]] == ["first", "second"]
