# Dockerfile for running aegis Layer 1 + Layer 2 tests
# This image runs unit tests and dry-run integration tests
# Does not require privileged mode or bubblewrap

FROM oven/bun:1

LABEL maintainer="aegis-tests"
LABEL description="aegis test runner for unit and dry-run integration tests"

# Install basic utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files first for better caching
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install --frozen-lockfile || bun install

# Copy the rest of the application
COPY . .

# Default command runs Layer 1 + Layer 2 tests.
# Deliberately `bun run test` rather than a second copy of the file list: this
# image exists to reproduce CI's "Layer 1 and Layer 2" step, which runs that
# same script, so an added suite must not be able to reach one and not the other.
CMD ["bun", "run", "test"]
