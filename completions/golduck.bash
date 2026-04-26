# shellcheck shell=bash
_golduck_completions() {
  local cur
  cur="${COMP_WORDS[COMP_CWORD]}"
  local subs="ask run plan verify dag skill memory hooks up down status doctor self-test trace daemon version help"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "$subs" -- "$cur"))
  fi
}
complete -F _golduck_completions golduck
