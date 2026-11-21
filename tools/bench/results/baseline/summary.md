# Benchmark state: baseline

Cells: 24. Generated 2026-11-18T13:25:59.523Z.
Recorded: 2026-11-17T21:14:46.865Z .. 2026-11-17T21:44:16.758Z; harness head: 5946170701a6d57e4dacc11c27ef76a85f49814e, (non-git task).

| task | model | wall s | calls | longest ms | tokens | errors | check | suite |
|---|---|---|---|---|---|---|---|---|
| count-extensions | deepseek-v4.1-flash | 9.5 | 1 | 59 | 27521 | 0 | pass | - |
| count-extensions | glm-5.3-flash | 7.7 | 1 | 39 | 26224 | 0 | pass | - |
| count-extensions | hy4-flash-free | 11.1 | 1 | 24 | 26754 | 0 | pass | - |
| devc-doctor | deepseek-v4.1-flash | 14 | 3 | 1590 | 31067 | 0 | pass | - |
| devc-doctor | glm-5.3-flash | 5.5 | 1 | 1308 | 15984 | 0 | pass | - |
| devc-doctor | hy4-flash-free | 9.3 | 2 | 1288 | 29528 | 0 | pass | - |
| devc-ls | deepseek-v4.1-flash | 7.6 | 1 | 661 | 16891 | 0 | pass | - |
| devc-ls | glm-5.3-flash | 5.2 | 1 | 680 | 15954 | 0 | pass | - |
| devc-ls | hy4-flash-free | 5.6 | 1 | 745 | 16353 | 0 | pass | - |
| find-poll-interval | deepseek-v4.1-flash | 6.4 | 1 | 12 | 27118 | 0 | pass | - |
| find-poll-interval | glm-5.3-flash | 4 | 1 | 12 | 25836 | 0 | pass | - |
| find-poll-interval | hy4-flash-free | 5.9 | 1 | 15 | 26299 | 0 | pass | - |
| full-suite | deepseek-v4.1-flash | 146.1 | 2 | 131999 | 43208 | 0 | pass | 1133/1 red |
| full-suite | glm-5.3-flash | 200.1 | 1 | 182992 | 26492 | 0 | pass | 1132/2 red |
| full-suite | hy4-flash-free | 167.1 | 1 | 148289 | 39747 | 1 | pass | 1132/2 red |
| head-hash | deepseek-v4.1-flash | 6.2 | 1 | 12 | 27058 | 0 | pass | - |
| head-hash | glm-5.3-flash | 2.8 | 1 | 15 | 25827 | 0 | pass | - |
| head-hash | hy4-flash-free | 11.8 | 1 | 26 | 26258 | 0 | pass | - |
| one-test-file | deepseek-v4.1-flash | 42.3 | 1 | 27936 | 27816 | 0 | pass | 26/0 |
| one-test-file | glm-5.3-flash | 16.5 | 1 | 7196 | 26534 | 0 | pass | 26/0 |
| one-test-file | hy4-flash-free | 12.3 | 1 | 6991 | 26959 | 0 | pass | 26/0 |
| subagent-alpha | deepseek-v4.1-flash | 35.4 | 5 | 15016 | 86483 | 1 | pass | - |
| subagent-alpha | glm-5.3-flash | 15.9 | 5 | 8013 | 82988 | 0 | pass | - |
| subagent-alpha | hy4-flash-free | 21.8 | 5 | 5048 | 86947 | 0 | pass | - |

`check` means the task was completed; `suite` is the runner's own pass/fail count when the task reports one. A red suite with a passing check is a completed task that measured a red suite, not a green one.

Each model contributes **one** run per task, so a median across models is not a distribution. Treat wall-time differences below ~2x as noise until there is a second run.

## Per-task median across models

| task | median wall s | median calls | median tokens |
|---|---|---|---|
| count-extensions | 9.5 | 1 | 26754 |
| devc-doctor | 9.3 | 2 | 29528 |
| devc-ls | 5.6 | 1 | 16353 |
| find-poll-interval | 5.9 | 1 | 26299 |
| full-suite | 167.1 | 1 | 39747 |
| head-hash | 6.2 | 1 | 26258 |
| one-test-file | 16.5 | 1 | 26959 |
| subagent-alpha | 21.8 | 5 | 86483 |
