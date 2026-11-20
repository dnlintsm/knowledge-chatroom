# Chat panel redesign proposal

This design makes room for long research answers and lets readers check sources, start a skill, or review a memory change from the chat pane. The screenshots show the interactive prototype with sample data and Traditional Chinese copy. The proposed production work is a frontend integration with the existing CopilotKit and AG-UI setup.

## Reading-first

The default prototype opens on the answer. User messages stay right-aligned, and small numbered citations open the referenced file or line range. The step summary expands to show tool calls, skills used, and memory reads. A memory proposal with a pending action appears below the answer.

![Reading-first chat panel with an inline citation, a pending memory proposal, and three follow-up questions](chat-panel/reading.png)

## Sources-first

This alternative opens on a list of sources with filenames and line ranges. Readers can preview an excerpt and switch to the answer. Both layouts use the same composer.

![Sources-first chat panel with two sources and the selected excerpt from eval-results.md](chat-panel/sources.png)

## Composer and generation

- The `+` menu groups attachments, tools, and per-chat skill settings. `/` opens the keyboard-accessible skill picker. Active tools and attachments appear above the input alongside the file and line selection.
- A compact memory control shows the mode and lets users pause memory for the current chat. Pending memory edits open for review. Users manage defaults and records in the Skills and Memory views.
- The prototype shows three suggested questions. At narrow widths they use two rows. A long label truncates visually, and selecting the suggestion inserts the full question into the draft.
- The model picker sits next to Send. The model options shown in the prototype are illustrative. A production picker should use the models enabled by the deployment.
- During a run, Send becomes a stop button with a progress ring. Stopping retains the response already shown. Completion returns the button to Send.

![Narrow dark-mode composer with three suggestions, the model picker, and the stop control during generation](chat-panel/generating.png)

## Integration

1. Update [ChatPane](../../apps/web/src/components/workspace/chat-pane.tsx) and [SkillChatInput](../../apps/web/src/components/workspace/skills.tsx) through the existing CopilotKit slots. Bind the send and stop affordances to the live run state. Keep the existing keyboard, attachment, suggestion and thread behaviors covered when integrating the new layout.
2. Reuse the existing Skills, Memory, and tool providers for per-thread settings and events. Summarize tool activity in the response, and surface memory changes that need review or can be undone next to the relevant answer.
3. Route the compact citation through the [workspace file-reference contract](../architecture.md#file-references-in-answers) and the existing editor navigation. Continue rendering `[note.md](/path/to/note.md#L12-L15)` as a file reference. If supporting `![note.md](…)` from existing replies, resolve the target against the user's workspace and treat a matched note as a citation. Render actual image targets through the image renderer.
4. Check narrow and wide layouts in both themes, keyboard navigation and IME composition, long suggestions, attachment and skill flows, streamed stop and completion, and citation navigation from a reopened thread.
