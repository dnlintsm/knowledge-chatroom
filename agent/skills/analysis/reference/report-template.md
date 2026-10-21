# Report template

Write these sections below the run's front matter. Keep it short: a reader
should get the answer from the first section.

```markdown
# <Run title>

## Summary

<Two to four sentences: the question, the answer, and how sure it is.>

## Inputs

| File | What it holds | Rows / size |
| --- | --- | --- |
| [inputs/<name>](inputs/<name>) | <one line> | <n> |

## Method

<Numbered steps: cleaning (rows dropped and why), filters, grouping,
formulas, and any script that ran. Enough for someone to repeat it.>

## Results

<Tables first, then a sentence per finding. Units on every number. Link
saved figures, e.g. ![Etch rate](artifacts/etch-rate.png).>

## Caveats

<Missing data, small samples, assumptions, anything the inputs couldn't
answer.>

## Next steps

<One to three concrete follow-ups, such as a rerun with other parameters.>
```
