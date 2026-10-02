# ============================================================
# 🌊 KOKOMI / SANGONOMIYA
# Powerlevel10k configuration — pastel ocean pill-style prompt
# Palette matches .devcontainer/pi/themes/kokomi-theme.json
# ============================================================
#
# Left side:
#   🌸  ~/Code/project   main
#   ❯
#
# Right side (only appears when relevant):
#   🐟 .venv     ⏱ 4s     ✘ 1     🕐 14:32
#

# ------------------------------------------------------------
# Palette (kept in one place so it's easy to retheme later)
# ------------------------------------------------------------
typeset -g KOKOMI_OCEAN_BLUE='#3d5a99'
typeset -g KOKOMI_DEEP_NAVY='#2a3a66'
typeset -g KOKOMI_LAVENDER='#a89bd4'
typeset -g KOKOMI_PEARL_WHITE='#e8ecf5'
typeset -g KOKOMI_CORAL='#e8a0a0'
typeset -g KOKOMI_SEAFOAM='#7ec8c8'
typeset -g KOKOMI_SUCCESS='#7ecba1'
typeset -g KOKOMI_WARNING='#e0c17a'

# ------------------------------------------------------------
# Layout
# ------------------------------------------------------------

typeset -g POWERLEVEL9K_LEFT_PROMPT_ELEMENTS=(
    kokomi
    dir
    vcs
    virtualenv
    newline
    prompt_char
)

typeset -g POWERLEVEL9K_RIGHT_PROMPT_ELEMENTS=(
    status
    command_execution_time
    background_jobs
    time
)

# ------------------------------------------------------------
# 🌸 Kokomi flower badge — first segment, native p10k segment
# ------------------------------------------------------------

function prompt_kokomi() {
    p10k segment \
        -b "$KOKOMI_DEEP_NAVY" \
        -f "$KOKOMI_CORAL" \
        -t '🌸'
}

# ------------------------------------------------------------
# Directory — ocean blue pill
# ------------------------------------------------------------

typeset -g POWERLEVEL9K_DIR_BACKGROUND="$KOKOMI_OCEAN_BLUE"
typeset -g POWERLEVEL9K_DIR_FOREGROUND="$KOKOMI_PEARL_WHITE"
typeset -g POWERLEVEL9K_DIR_SHORTENED_FOREGROUND="$KOKOMI_PEARL_WHITE"
typeset -g POWERLEVEL9K_DIR_ANCHOR_FOREGROUND="$KOKOMI_SEAFOAM"
typeset -g POWERLEVEL9K_DIR_ANCHOR_BOLD=true
typeset -g POWERLEVEL9K_DIR_VISUAL_IDENTIFIER_EXPANSION='📁 '

# Don't make paths enormous.
typeset -g POWERLEVEL9K_SHORTEN_STRATEGY='truncate_to_unique'
typeset -g POWERLEVEL9K_SHORTEN_DELIMITER='…'

# ------------------------------------------------------------
# Git — color-coded lavender/seafoam/coral pill by status
# ------------------------------------------------------------

typeset -g POWERLEVEL9K_VCS_VISUAL_IDENTIFIER_EXPANSION=$'\uE0A0 '
typeset -g POWERLEVEL9K_VCS_CONTENT_EXPANSION='${VCS_STATUS_BRANCH}'

typeset -g POWERLEVEL9K_VCS_CLEAN_BACKGROUND="$KOKOMI_SEAFOAM"
typeset -g POWERLEVEL9K_VCS_CLEAN_FOREGROUND="$KOKOMI_DEEP_NAVY"

typeset -g POWERLEVEL9K_VCS_MODIFIED_BACKGROUND="$KOKOMI_CORAL"
typeset -g POWERLEVEL9K_VCS_MODIFIED_FOREGROUND="$KOKOMI_DEEP_NAVY"

typeset -g POWERLEVEL9K_VCS_UNTRACKED_BACKGROUND="$KOKOMI_WARNING"
typeset -g POWERLEVEL9K_VCS_UNTRACKED_FOREGROUND="$KOKOMI_DEEP_NAVY"

# ------------------------------------------------------------
# Virtualenv — little fish, an homage to Kokomi's companion 🐟
# Shows automatically when $VIRTUAL_ENV is set (e.g. uv venv)
# ------------------------------------------------------------

typeset -g POWERLEVEL9K_VIRTUALENV_BACKGROUND="$KOKOMI_LAVENDER"
typeset -g POWERLEVEL9K_VIRTUALENV_FOREGROUND="$KOKOMI_DEEP_NAVY"
typeset -g POWERLEVEL9K_VIRTUALENV_VISUAL_IDENTIFIER_EXPANSION='🐟 '
typeset -g POWERLEVEL9K_VIRTUALENV_SHOW_PYTHON_VERSION=false

# ------------------------------------------------------------
# Newline
# ------------------------------------------------------------

typeset -g POWERLEVEL9K_MULTILINE_FIRST_PROMPT_PREFIX=''
typeset -g POWERLEVEL9K_MULTILINE_LAST_PROMPT_PREFIX=''

# ------------------------------------------------------------
# Prompt character — kept flat/unboxed, it's the "cursor", not a badge
# ------------------------------------------------------------

typeset -g POWERLEVEL9K_PROMPT_CHAR_BACKGROUND=''
typeset -g POWERLEVEL9K_PROMPT_CHAR_OK_VICMD_FOREGROUND="$KOKOMI_SEAFOAM"
typeset -g POWERLEVEL9K_PROMPT_CHAR_OK_VIVIS_FOREGROUND="$KOKOMI_SEAFOAM"
typeset -g POWERLEVEL9K_PROMPT_CHAR_OK_VIINS_FOREGROUND="$KOKOMI_SEAFOAM"
typeset -g POWERLEVEL9K_PROMPT_CHAR_ERROR_FOREGROUND="$KOKOMI_CORAL"

typeset -g POWERLEVEL9K_PROMPT_CHAR_OK_VIINS_CONTENT='❯'
typeset -g POWERLEVEL9K_PROMPT_CHAR_ERROR_VIINS_CONTENT='❯'

# ------------------------------------------------------------
# Right-side extras — quiet by default, only appear when useful
# ------------------------------------------------------------

# Exit status: hidden on success, coral pill with code on failure.
typeset -g POWERLEVEL9K_STATUS_OK=false
typeset -g POWERLEVEL9K_STATUS_ERROR=true
typeset -g POWERLEVEL9K_STATUS_ERROR_BACKGROUND="$KOKOMI_CORAL"
typeset -g POWERLEVEL9K_STATUS_ERROR_FOREGROUND="$KOKOMI_DEEP_NAVY"
typeset -g POWERLEVEL9K_STATUS_ERROR_VISUAL_IDENTIFIER_EXPANSION='✘ '

# Command timer: only shows once a command runs 3s+.
typeset -g POWERLEVEL9K_COMMAND_EXECUTION_TIME_THRESHOLD=3
typeset -g POWERLEVEL9K_COMMAND_EXECUTION_TIME_PRECISION=0
typeset -g POWERLEVEL9K_COMMAND_EXECUTION_TIME_BACKGROUND="$KOKOMI_WARNING"
typeset -g POWERLEVEL9K_COMMAND_EXECUTION_TIME_FOREGROUND="$KOKOMI_DEEP_NAVY"
typeset -g POWERLEVEL9K_COMMAND_EXECUTION_TIME_VISUAL_IDENTIFIER_EXPANSION='⏱ '

# Background jobs: only shows when something's actually backgrounded.
typeset -g POWERLEVEL9K_BACKGROUND_JOBS_BACKGROUND="$KOKOMI_LAVENDER"
typeset -g POWERLEVEL9K_BACKGROUND_JOBS_FOREGROUND="$KOKOMI_DEEP_NAVY"
typeset -g POWERLEVEL9K_BACKGROUND_JOBS_VISUAL_IDENTIFIER_EXPANSION='⚙ '

# Clock: small, quiet, always in the corner.
typeset -g POWERLEVEL9K_TIME_BACKGROUND="$KOKOMI_DEEP_NAVY"
typeset -g POWERLEVEL9K_TIME_FOREGROUND="$KOKOMI_PEARL_WHITE"
typeset -g POWERLEVEL9K_TIME_FORMAT='%D{%H:%M}'
typeset -g POWERLEVEL9K_TIME_VISUAL_IDENTIFIER_EXPANSION='🕐 '

# ------------------------------------------------------------
# Shape — rounded pill separators, soft edges to match the aesthetic
# ------------------------------------------------------------

typeset -g POWERLEVEL9K_LEFT_PROMPT_FIRST_SEGMENT_START_SYMBOL=$'\uE0B6'
typeset -g POWERLEVEL9K_LEFT_PROMPT_LAST_SEGMENT_END_SYMBOL=$'\uE0B4'
typeset -g POWERLEVEL9K_LEFT_SEGMENT_SEPARATOR=$'\uE0B4'
typeset -g POWERLEVEL9K_LEFT_SUBSEGMENT_SEPARATOR=$'\uE0B5'

typeset -g POWERLEVEL9K_RIGHT_PROMPT_FIRST_SEGMENT_START_SYMBOL=$'\uE0B6'
typeset -g POWERLEVEL9K_RIGHT_PROMPT_LAST_SEGMENT_END_SYMBOL=$'\uE0B4'
typeset -g POWERLEVEL9K_RIGHT_SEGMENT_SEPARATOR=$'\uE0B6'
typeset -g POWERLEVEL9K_RIGHT_SUBSEGMENT_SEPARATOR=$'\uE0B7'

typeset -g POWERLEVEL9K_MODE='nerdfont-complete'