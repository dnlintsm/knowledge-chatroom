---
name: analysis
description: Analyze files the user uploaded (CSV, tables, measurement logs, notes) as a run - a new experiment with the files as inputs, a written report and recorded results. Use when the user asks to analyze, evaluate or run an analysis on their data, or to rerun an earlier analysis.
argument-hint: "[files or question]"
---

# Analysis run

Every analysis is a **run**: an experiment with its inputs, a report.md and
results, so it can be compared, shared and rerun later. Never analyze
straight into notes or artifacts outside a run.

1. **Pick the inputs.** Use the files the user names, else the open file or
   selection, else recent uploads (`list_files`, `search_files`). If it is
   unclear which files, ask once. Note each file's place (root, `node` or
   `experiment`).
2. **Start the run.** Call `create_experiment` with:
   - `title`: what is analyzed, e.g. "Etch rate vs. RF power, lot 42";
   - `node`: where the user is (the context's currentNode), else omit;
   - `inputs`: every file you will read, with its `node` / `experiment`;
   - `hypothesis`: the user's question, in one or two sentences;
   - `params`: settings you choose (filters, grouping, thresholds);
   - `skill`: `analysis`.

   To **rerun** an earlier run, pass `rerunOf` with its id instead (and only
   what changes). Never edit a finished run.
3. **Read the inputs** from the run: `read_file` with `experiment` = the new
   run's id and `path` = `inputs/<name>`. Page long files with offset/limit.
4. **Compute.** For small tables, work it out from what you read and show
   the arithmetic you rely on. When scripts are available (you have Bash),
   profile CSV files with the bundled script instead of reading every row:

   ```bash
   mkdir -p out && node .claude/skills/analysis/scripts/profile.mjs run-inputs/<run id>/data.csv > out/profile.json
   ```

   Always profile the run's own copy: `create_experiment` returns where each
   input is in the working folder (`inputsInWorkingFolder`), the exact
   version the run linked. In a later turn it is under the run's folder,
   `workspace/experiments/<title> (<id>)/inputs/`. Not the file under
   `workspace/root/` or `workspace/nodes/`, which may be an older snapshot.
   The script prints per-column counts, missing values, numeric
   min/max/mean/std and top values as JSON. Save figures or tables a script makes with `save_file`
   into the run's `artifacts/`.
5. **Write the report** in the run's `report.md`, below its front matter
   (keep the front matter as it is), following
   [reference/report-template.md](reference/report-template.md). Every
   number in it must come from the inputs; say what you couldn't determine.
6. **Record the results** with `set_experiment_results`: the few headline
   numbers, keys with units (e.g. `{"etchRate_nm_min": 41.2, "rows": 1200}`),
   and `state` `done`. If the analysis couldn't be completed (unreadable
   file, missing columns), write why in the report and finish with `failed`.
7. **Tell the user** in two or three lines: the main finding, a link to the
   report ([report.md](report.md)), and that the run is a private draft until
   they share it.
