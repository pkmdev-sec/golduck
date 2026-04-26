#compdef golduck

_golduck() {
  local -a subs
  subs=(
    'ask:One-shot deep question with panel verify'
    'run:Autonomous run with tools + streaming'
    'plan:Produce a decomposition plan'
    'verify:Panel-critic verifier on <question> <answer>'
    'dag:Run a DAG file'
    'skill:List/run user skills'
    'memory:Pinned memory operations'
    'hooks:Manage hook scripts'
    'up:Start proxy + daemon + MCP'
    'down:Stop golduck services'
    'status:Show daemon + proxy health'
    'doctor:Diagnose the environment'
    'self-test:End-to-end live smoke'
    'trace:Render the JSONL trace'
    'daemon:Low-level daemon lifecycle'
    'version:Print version/commit'
    'help:Show help'
  )
  _describe 'command' subs
}
compdef _golduck golduck
