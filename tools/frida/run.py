#!/usr/bin/env python3
"""
Host runner for agent.js — attaches to the Dofus client, loads the dumper,
receives the result, writes it, and exits (no hanging REPL).

Must run under the python that has the `frida` module (the pipx frida-tools
venv). run.sh handles that; to call directly:
    ~/.local/pipx/venvs/frida-tools/bin/python run.py [-n NAME | -p PID | -f TARGET]
"""
import argparse
import json
import os
import sys
import time

import frida

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "agent.js")
OUT = "/tmp/dofus_protocol.json"
TIMEOUT = 120  # seconds to wait for the dump


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group()
    g.add_argument("-n", "--name", default="Dofus", help='process name (default "Dofus")')
    g.add_argument("-p", "--pid", type=int, help="attach by pid")
    g.add_argument("-f", "--spawn", help="spawn this target (bundle id / path)")
    ap.add_argument("-a", "--agent", default=AGENT, help="agent .js to load (default agent.js)")
    args = ap.parse_args()

    with open(args.agent, encoding="utf-8") as fh:
        source = fh.read()

    device = frida.get_local_device()

    spawned_pid = None
    if args.spawn:
        spawned_pid = device.spawn([args.spawn])
        session = device.attach(spawned_pid)
    elif args.pid:
        session = device.attach(args.pid)
    else:
        session = device.attach(args.name)

    done = {"ok": False}

    def on_message(message, data):
        if message["type"] == "send":
            payload = message["payload"]
            if isinstance(payload, dict) and payload.get("event") == "done":
                with open(OUT, "w", encoding="utf-8") as w:
                    json.dump({"messages": payload["messages"], "idMap": payload["idMap"]}, w, indent=1)
                print(">> wrote %s  (messages=%d, ids=%d)"
                      % (OUT, len(payload["messages"]), len(payload["idMap"])))
                done["ok"] = True
            else:
                print("[send]", payload)
        elif message["type"] == "log":
            # the agent's console.log — its only progress signal during the
            # class scan, which runs inside script.load() and can take minutes
            print("[log]", message.get("payload"), flush=True)
        elif message["type"] == "error":
            print("[error]", message.get("stack") or message.get("description"), file=sys.stderr)

    script = session.create_script(source)
    script.on("message", on_message)
    # the agent body runs synchronously inside load(): the scan finishes (and
    # `done` usually arrives) before this returns
    print(">> loading agent — scanning classes, this takes minutes", flush=True)
    script.load()
    if spawned_pid is not None:
        device.resume(spawned_pid)

    deadline = time.time() + TIMEOUT
    while not done["ok"] and time.time() < deadline:
        time.sleep(0.2)

    try:
        session.detach()
    except frida.Error:
        pass

    if not done["ok"]:
        print(">> timed out after %ds without a 'done' message — see log above" % TIMEOUT, file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
