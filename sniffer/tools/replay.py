#!/usr/bin/env python3
"""
Replay captured frames over loopback so the sniffer can be exercised without
the game running.

Opens a TCP server on 127.0.0.1:5555, connects to it, and pushes the same
length-prefixed frames both ways. The sniffer capturing on lo0 sees a normal
bidirectional flow: deframing, Any unwrapping, interpreters, callbacks and the
database writes all run exactly as they do against the real server.

Useful because the alternative -- launching the client for every change -- is
slow, and the Frida work tends to leave it unresponsive.

Usage:
    # terminal 1
    DATABASE_URL=... ./target/debug/SniffSniffSquared --dev lo0 --all "tcp port 5555"
    # terminal 2
    tools/replay.py [--count N] [--hex HEXSTRING]

Default payload is the real `kdh` (price list) frame from
docs/observations.md, length prefix included. It must be sent several times:
the deframer locks its layout only after three consecutive valid parses.
"""
import argparse
import socket
import threading
import time

# real captured kdh frame, including the leading 0x35 varint length prefix
KDH_FRAME = (
    "350a330a310a13747970652e616e6b616d612e636f6d2f6b6468121a0a1308e13f1068"
    "22088a03c50fa4c3010028ab9d0118e13f2068"
)

HOST, PORT = "127.0.0.1", 5555


def serve(frame, count, ready):
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((HOST, PORT))
    srv.listen(1)
    ready.set()
    conn, _ = srv.accept()
    for _ in range(count):
        conn.sendall(frame)
        time.sleep(0.05)
    time.sleep(0.5)
    conn.close()
    srv.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=6,
                    help="frames per direction (must be >=3 to lock the deframer)")
    ap.add_argument("--hex", default=KDH_FRAME, help="frame bytes as hex, length prefix included")
    args = ap.parse_args()

    frame = bytes.fromhex(args.hex)
    if args.count < 3:
        print("warning: fewer than 3 frames — the deframer will not lock a layout")

    ready = threading.Event()
    threading.Thread(target=serve, args=(frame, args.count, ready), daemon=True).start()
    ready.wait(5)

    client = socket.create_connection((HOST, PORT))
    for _ in range(args.count):
        client.sendall(frame)
        time.sleep(0.05)
    time.sleep(1.0)
    client.close()
    print("replayed %d frames each way (%d bytes each)" % (args.count, len(frame)))


if __name__ == "__main__":
    main()
