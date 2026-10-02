#!/usr/bin/env bash

model="${1:?Usage: $0 <model>}"

tmux new -A -s pi 'pi' --provider openrouter --model "openrouter/$model"