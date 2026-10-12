---
name: write-skill
description: Turn a workflow from this conversation, or one the user describes, into a reusable workspace skill (skills/<name>/SKILL.md). Use when the user asks to save, capture or automate how something was done.
argument-hint: "[what the skill should do]"
disable-model-invocation: true
---

# Write a skill

A skill is a folder `skills/<name>/` with a `SKILL.md` that teaches you a
workflow. Only its front matter is always in your context, so the description
decides when it is used.

1. Work out the workflow: from the user's words after the command, or from
   what worked earlier in this conversation. Ask one question only if the goal
   is unclear.
2. Pick a short kebab-case name (lowercase letters, digits, dashes).
3. Write `skills/<name>/SKILL.md` with the workspace file tools:

   ```markdown
   ---
   name: <name>
   description: <what it does and when to use it, one or two sentences>
   argument-hint: "[optional input]"
   ---

   # <Title>

   <numbered steps, inputs, the shape of the output, and pitfalls>
   ```

   Keep it instructions only: skills here can't run scripts.
4. Tell the user in one line that it is saved, that `/<name>` runs it, and
   that they can switch it to Auto, Manual or Off in the Skills panel.
