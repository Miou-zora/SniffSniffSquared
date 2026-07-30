#!/usr/bin/env python3
"""
Host runner for agent.js — attaches to the Dofus client, loads the dumper,
receives the result, writes it, and exits (no hanging REPL).

Must run under the python that has the `frida` module (the pipx frida-tools
venv). run.sh handles that; to call directly:
    ~/.local/pipx/venvs/frida-tools/bin/python run.py [-n NAME | -p PID | -f TARGET]
"""
import argparse
import base64
import json
import os
import sys
import time

import frida

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT = os.path.join(HERE, "agent.js")
OUT = "/tmp/dofus_protocol.json"
TIMEOUT = 900  # seconds to wait for the dump; the scan runs on the game threads


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
    # accumulated as it streams in, so an abort still leaves usable output
    acc = {"files": {}, "classMap": {}}

    def flush(note):
        with open(OUT, "w", encoding="utf-8") as w:
            json.dump(acc, w, indent=1)
        print(">> wrote %s  (files=%d, messages=%d) %s"
              % (OUT, len(acc["files"]), len(acc["classMap"]), note), flush=True)

    def on_message(message, data):
        if message["type"] == "send":
            payload = message["payload"]
            if not isinstance(payload, dict):
                print("[send]", payload)
                return
            ev = payload.get("event")
            if ev == "file":
                acc["files"][payload["name"]] = payload["hex"]
                print("[file] %s (%d bytes)" % (payload["name"], len(payload["hex"]) // 2), flush=True)
            elif ev == "hb":
                where = payload.get("invoking") or payload.get("skipped") or payload.get("at") or ""
                print("[hb] %-34s scanned=%-6d msgs=%-4d files=%-3d %s%s"
                      % (payload.get("asm"), payload.get("scanned", 0),
                         payload.get("messages", 0), payload.get("files", 0),
                         ("INVOKING " if payload.get("invoking") else "SKIP " if payload.get("skipped") else ""), where), flush=True)
            elif ev == "classmap":
                acc["classMap"].update(payload["chunk"])
            elif ev == "done":
                flush("- complete")
                done["ok"] = True
            else:
                print("[send]", payload)
        elif message["type"] == "log":
            # the agent's console.log — the per-assembly progress signal
            print("[log]", message.get("payload"), flush=True)
        elif message["type"] == "error":
            print("[error]", message.get("stack") or message.get("description"), file=sys.stderr)

    script = session.create_script(source)
    script.on("message", on_message)
    print(">> loading agent — the client will be unresponsive while it scans", flush=True)
    deadline = time.time() + TIMEOUT
    try:
        # The agent scans synchronously, so load() usually exceeds frida's RPC
        # deadline and raises TransportError. The agent is still running inside
        # the process and still sending -- detaching here is what loses the
        # dump. Keep waiting instead.
        try:
            script.load()
            if spawned_pid is not None:
                device.resume(spawned_pid)
        except frida.TransportError as e:
            print(">> load() timed out (%s) -- agent keeps running, still listening" % e,
                  file=sys.stderr, flush=True)

        while not done["ok"] and time.time() < deadline:
            time.sleep(0.2)
    except KeyboardInterrupt:
        print("\n>> interrupted", file=sys.stderr)
    except Exception as e:
        # never lose what already streamed in
        print("\n>> %s: %s" % (type(e).__name__, e), file=sys.stderr)

    # Write BEFORE detaching. detach() blocks indefinitely when the agent is
    # wedged inside the process, and anything not yet on disk is lost with it.
    if not done["ok"]:
        if acc["files"] or acc["classMap"]:
            flush("- PARTIAL, scan did not finish")
        else:
            print(">> nothing received — see log above", file=sys.stderr)

    try:
        session.detach()
    except frida.Error:
        pass

    if not done["ok"]:
        sys.exit(1)


if __name__ == "__main__":
    main()
