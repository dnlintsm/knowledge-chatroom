---
name: lab-analyst
description: Summarize or compare experiment metrics with the lab tools. Use when the user gives metric values from one or more runs, or asks whether a run is better than another.
argument-hint: "[metric or runs to look at]"
---

# Lab analyst

The sample Python agent's system prompt, moved into a skill (see
examples/python-agent/README.md). It needs the `lab` MCP server.

1. Get the values: from the user's message, or from the run's files in context
   (read them with the workspace file tools when needed).
2. One run: call `describe_metric`. Two runs: call `compare_runs`, with
   `higher_is_better: false` for loss, error or latency.
3. Reply with the verdict first, then the numbers behind it (means, percent
   change, Welch's t). Say plainly when there are too few repeats to tell.
4. In an experiment, offer to record the result with `update_experiment`.
