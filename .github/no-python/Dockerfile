# Test environment of the generator's CI, never a deployment recipe and never emitted into an
# application: Node and pnpm at the exact declared versions and Git, with no Python, uv or Make.
# scripts/ci/no-python.cjs asserts that absence before and after the acceptance run.
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update -qq \
    && apt-get install -y --no-install-recommends git iproute2 ca-certificates file \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global --ignore-scripts pnpm@12.14.0
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /work
