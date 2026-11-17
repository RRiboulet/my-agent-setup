# Benchmark state: baseline

Cells: 24. Generated 2026-11-17T15:34:08.842Z.

| task | model | wall s | calls | longest ms | tokens | errors | check |
|---|---|---|---|---|---|---|---|
| count-extensions | deepseek-v4.1-flash | 14.9 | 1 | 15 | 27519 | 0 | pass |
| count-extensions | glm-5.3-flash | 9.9 | 1 | 13 | 26224 | 0 | pass |
| count-extensions | hy4-flash-free | 14.7 | 1 | 21 | 26849 | 0 | pass |
| devc-doctor | deepseek-v4.1-flash | 29 | 6 | 1471 | 79613 | 0 | pass |
| devc-doctor | glm-5.3-flash | 9.2 | 2 | 2046 | 29023 | 0 | pass |
| devc-doctor | hy4-flash-free | 8.3 | 1 | 2039 | 16348 | 0 | pass |
| devc-ls | deepseek-v4.1-flash | 10.6 | 1 | 1474 | 16899 | 0 | pass |
| devc-ls | glm-5.3-flash | 9.8 | 1 | 1586 | 15962 | 0 | pass |
| devc-ls | hy4-flash-free | 13.7 | 2 | 1353 | 29849 | 0 | pass |
| find-poll-interval | deepseek-v4.1-flash | 11.9 | 1 | 22 | 27144 | 0 | pass |
| find-poll-interval | glm-5.3-flash | 10.8 | 1 | 16 | 25842 | 0 | pass |
| find-poll-interval | hy4-flash-free | 7.4 | 1 | 50 | 26310 | 0 | pass |
| full-suite | deepseek-v4.1-flash | 125.3 | 3 | 111444 | 56648 | 0 | pass |
| full-suite | glm-5.3-flash | 114.1 | 1 | 110714 | 26221 | 0 | pass |
| full-suite | hy4-flash-free | 170.8 | 1 | 151321 | 39514 | 1 | pass |
| head-hash | deepseek-v4.1-flash | 7.1 | 1 | 16 | 27058 | 0 | pass |
| head-hash | glm-5.3-flash | 3.5 | 1 | 13 | 25827 | 0 | pass |
| head-hash | hy4-flash-free | 7.5 | 1 | 14 | 26294 | 0 | pass |
| one-test-file | deepseek-v4.1-flash | 78.4 | 1 | 59759 | 27817 | 0 | pass |
| one-test-file | glm-5.3-flash | 83 | 1 | 64889 | 26568 | 0 | pass |
| one-test-file | hy4-flash-free | 27.5 | 1 | 14472 | 26997 | 0 | pass |
| subagent-alpha | deepseek-v4.1-flash | 11.6 | 4 | 190 | 71823 | 1 | pass |
| subagent-alpha | glm-5.3-flash | 19.7 | 4 | 8011 | 69576 | 0 | pass |
| subagent-alpha | hy4-flash-free | 16 | 5 | 95 | 90210 | 0 | pass |

## Per-task median across models

| task | median wall s | median calls | median tokens |
|---|---|---|---|
| count-extensions | 14.7 | 1 | 26849 |
| devc-doctor | 9.2 | 2 | 29023 |
| devc-ls | 10.6 | 1 | 16899 |
| find-poll-interval | 10.8 | 1 | 26310 |
| full-suite | 125.3 | 1 | 39514 |
| head-hash | 7.1 | 1 | 26294 |
| one-test-file | 78.4 | 1 | 26997 |
| subagent-alpha | 16.0 | 4 | 71823 |
