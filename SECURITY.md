# Security Policy

## Supported versions

This is a research project with no releases. Only the current `main` is
supported; fixes land there and nowhere else.

| version | supported |
|---|---|
| `main` | yes |
| any tag, branch or fork | no |

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting on this repository: **Security →
Advisories → Report a vulnerability**. That opens a private thread visible only
to you and the maintainer.

Please include:

- what the bug is, and which component — `sniffer/`, `web/`, `tools/`, compose;
- how to reproduce it, ideally as a **minimal byte fixture** rather than a whole
  capture file;
- what an attacker gets out of it, and what they need to be in a position to do
  it;
- the commit you saw it on, and — for anything protocol-related — the client
  build.

**Redact other players before you send anything.** Captures carry character names
and chat messages belonging to people who did not agree to be in a bug report.
Replace them (`Player-Redacted-02`, `<chat message text>`) exactly as you would in
a committed fixture.

This is a single-maintainer hobby project. Expect an acknowledgement within about
a week, and a fix on a best-effort schedule after that. If you plan to publish,
tell me when — I will not ask you to sit on a finding indefinitely, and credit is
yours unless you would rather not have it.

## What counts as a vulnerability here

The threat model is narrow but real. **Everything arriving on TCP 5555 is
untrusted input**: the decoder parses bytes from the network, and it is often run
with capture privileges (`access_bpf`, `cap_net_raw`, or plain `sudo`). Anything
that lets those bytes do more than they should is in scope.

In scope:

- **Memory unsafety or undefined behaviour in the decoder** — any `unsafe`, or a
  dependency reached through crafted input.
- **A panic, hang, or unbounded allocation from a crafted or truncated frame.**
  The deframer, `Any` unwrapper, varint reader and schema walker all take
  attacker-shaped input. A panic ends the capture; an unbounded length prefix
  exhausts memory. Wire data is `Option`/`Result` throughout precisely for this,
  so a reachable `unwrap()` on wire data is a bug worth reporting on its own.
- **SQL injection** through wire-derived values — item names, chat text, anything
  that travels from a packet into `packets`, `prices` or the other tables, or out
  of them into `web/`.
- **Injection in `web/`** — stored XSS from captured strings rendered in the
  dashboard, SSRF or path traversal through the read-time DofusDB enrichment,
  anything that turns a captured value into code.
- **Credential and data exposure** — `.env` or `backups/` handled in a way that
  leaks them, a script that logs `DATABASE_URL`, a container that binds wider
  than it should.
- **Supply chain** — a compromised or malicious dependency in `Cargo.toml`,
  `web/package.json`, or the pinned skills in `skills-lock.json`. One known
  wrinkle is documented rather than hidden: the `writing-guidelines` skill
  fetches its rules from `raw.githubusercontent.com` at run time, so its
  behaviour is not pinned by `skills-lock.json` the way every other skill's is.

## What is not a vulnerability here

- **Vulnerabilities in the game itself.** If you find a flaw in Ankama's client
  or servers, report it to Ankama. It does not belong in this repository's
  issues, advisories, or code. This project observes a protocol; it does not
  attack an implementation of it, and pull requests that weaponise a finding
  against the live game will be closed.
- **The default credentials in `.env.example`.** `change_me` is a placeholder for
  a database that is meant to be bound to localhost on one developer's machine.
- **No authentication on `web/` or pgAdmin.** Neither has any, by design: they
  are local single-user tools. Publishing either to the internet is
  misconfiguration, not a bug — see below.
- **Anything that requires an attacker who is already root on your machine**, or
  who already has your capture privileges.
- **Passive capture itself.** Reading traffic your own client sends, on your own
  machine, is what the project is for.

## Running it safely

- **Do not expose the compose stack.** `db`, `pgadmin`, `web` and `web-dev` are
  meant for localhost. Nothing in them expects a hostile network, and none of
  them authenticate.
- **Change `POSTGRES_PASSWORD` and `PGADMIN_PASS`** from `change_me` even
  locally, and keep `.env` out of git — `.gitignore` already covers it.
- **Prefer capability over `sudo`.** On Linux,
  `sudo setcap cap_net_raw,cap_net_admin=eip ./target/debug/SniffSniffSquared`
  once, then run it as yourself. On macOS, membership of `access_bpf` does the
  same job. Running the whole decoder as root is avoidable.
- **Keep the BPF filter tight.** `tcp port 5555` is both the useful filter and
  the one that keeps unrelated traffic — yours and everyone else's on the
  segment — out of the process entirely.
- **`backups/` is real captured data.** It contains other players' names and chat
  alongside your own. It is gitignored; treat it as personal data on disk, and
  think before copying it anywhere.
- **`sniffer/tools/frida/` attaches to a process and will eventually crash it.**
  Only ever attach to the re-signed *copy* made by `resign-debug-app.sh`, never to
  the real install and never to a client anyone is playing on.

## Scope of the project, restated

The project is passive: it connects to nothing, sends nothing, and modifies no
part of the game. Requests to add packet injection, automation, credential
handling, or anti-cheat evasion are refused as a matter of scope, not of
politeness — see [CONTRIBUTING.md](CONTRIBUTING.md#what-this-project-accepts-and-what-it-does-not).
