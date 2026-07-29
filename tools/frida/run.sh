#!/usr/bin/env bash
# Build (if needed) and run the Dofus 3 protocol dumper agent.
#
# Usage:
#   ./run.sh                    attach to a running client (default name "Dofus")
#   ./run.sh -n "Dofus 3"       attach to a differently-named process
#   ./run.sh -f com.ankama.dofus   spawn the app by bundle id / path
#   ./run.sh -p 12345           attach by pid
#
# Output (written by the agent, on this machine): /tmp/dofus_protocol.json
set -euo pipefail
cd "$(dirname "$0")"

NAME="Dofus"
SPAWN=""
PID=""
while getopts "n:f:p:h" opt; do
  case "$opt" in
    n) NAME="$OPTARG" ;;
    f) SPAWN="$OPTARG" ;;
    p) PID="$OPTARG" ;;
    h) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "bad flag; -h for help" >&2; exit 2 ;;
  esac
done

command -v frida >/dev/null || { echo "frida CLI not found. Install: pipx install frida-tools (or pip install frida-tools)"; exit 1; }

# deps
[ -d node_modules/frida-il2cpp-bridge ] || npm install

# (re)build if agent.js missing or older than the source
if [ ! -f agent.js ] || [ agent.ts -nt agent.js ]; then
  echo ">> compiling agent.ts"
  npx --yes frida-compile agent.ts -o agent.js
fi

OUT=/tmp/dofus_protocol.json
rm -f "$OUT"

# run.py needs the python that has the frida module (the pipx frida-tools venv)
FRIDA_BIN="$(command -v frida)"
FRIDA_PY="$(dirname "$(readlink "$FRIDA_BIN" || echo "$FRIDA_BIN")")/python"
[ -x "$FRIDA_PY" ] || FRIDA_PY="python3"

echo ">> running (output -> $OUT)"
if [ -n "$SPAWN" ]; then
  "$FRIDA_PY" run.py -f "$SPAWN"
elif [ -n "$PID" ]; then
  "$FRIDA_PY" run.py -p "$PID"
else
  "$FRIDA_PY" run.py -n "$NAME"
fi
