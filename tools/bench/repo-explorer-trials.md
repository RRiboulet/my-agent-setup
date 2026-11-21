# repo-explorer trials

A model run cannot measure a TUI: the thing under test is how many keystrokes and
how much time it takes a human on a phone-sized terminal to answer one question.
So this part of ticket 00 is a manual protocol with a recorded table, not a
script.

## Protocol

1. Start from a terminal at **80×24** (tmux pane or a phone SSH client with the
   same size). Note the client; a hardware keyboard and a soft keyboard are not
   the same test.
2. Open a branch with at least 12 branches and at least 3 changed files,
   including one untracked file and one uncommitted edit.
3. Start the stopwatch at the moment you type the command. Stop it when you can
   state the answer to the question below. Count keystrokes (Enter, arrows,
   filter characters) separately.
4. Repeat five times. Do not re-read the file list between trials; that is the
   point of the fifth trial.

The question: **"Which files changed on this branch, and what does the diff for
the largest one say?"**

## Record

| trial | command | time (s) | keystrokes | answer correct? | notes |
|---|---|---|---|---|---|
| 1 |  |  |  |  |  |
| 2 |  |  |  |  |  |
| 3 |  |  |  |  |  |
| 4 |  |  |  |  |  |
| 5 |  |  |  |  |  |

Baseline (before ticket 04):

| metric | value |
|---|---|
| median time |  |
| median keystrokes |  |
| trials that flooded the chat |  |
| trials that showed the wrong branch |  |

## What counts as an improvement

- The answer is correct in every trial (a faster wrong answer is not better).
- Nothing is appended to the model context unless `s` was pressed.
- The current branch is the default, so Enter does not browse a neighbour.
- Median keystrokes fall, and no trial loses the browser to a failed read.
