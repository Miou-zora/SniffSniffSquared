# Build and run the sniffer.
#
# Capture only works where the container can see the real network interface —
# i.e. Linux with `network_mode: host` and CAP_NET_RAW. On macOS and Windows,
# Docker runs containers inside a Linux VM whose "host" network is the VM, not
# your machine, so the game traffic is simply not visible from in here. Run the
# binary natively there instead (see RUNBOOK part 2).

FROM rust:1-slim-bookworm AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends libpcap-dev pkg-config \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src

# dependencies first, so source edits do not re-download the world
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs \
 && cargo build --release \
 && rm -rf src

COPY src ./src
# schema.rs compiles this in as the fallback for a sniffer started from the
# wrong directory, so the build needs it even though compose bind-mounts it
COPY schema.json ./schema.json
# cargo skips rebuilds on unchanged mtimes; the dummy main.rs above shares one
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libpcap0.8 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The binary resolves keymap.json and proto/messages.json relative to the
# working directory, so both must sit beside it here.
WORKDIR /app
COPY --from=build /src/target/release/SniffSniffSquared /usr/local/bin/sniffer
COPY proto ./proto
COPY keymap.json ./keymap.json
COPY schema.json ./schema.json

ENTRYPOINT ["sniffer"]
CMD ["--all", "tcp port 5555"]
