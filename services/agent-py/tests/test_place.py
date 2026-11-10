from __future__ import annotations

from ag_ui.core import RunAgentInput, TextInputContent, UserMessage

from agent_py.adapter import with_note
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
