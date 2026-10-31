# Node >= 24.9 required (DSH floor). The tag floats to the latest 24.x and
# points at a newer major when overridden:
#   docker build --build-arg NODE_VERSION=26 ...
ARG NODE_VERSION=24

# ---- build: compile TypeScript ------------------------------------------------
FROM node:${NODE_VERSION}-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# ---- prod-deps: runtime dependencies only -------------------------------------
FROM node:${NODE_VERSION}-slim AS prod-deps
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# ---- runtime ------------------------------------------------------------------
FROM node:${NODE_VERSION}-slim AS runtime

# Tooling the agent CLIs expect once installed (Claude Code uses git/ripgrep;
# openssh-client covers git remotes). Kept in the base image so users only need
# to add the CLI itself.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ripgrep ca-certificates openssh-client less \
 && rm -rf /var/lib/apt/lists/*

# The image ships the daemon only. Agent CLIs are installed by the operator
# (docker exec or a derived image); a user-writable global prefix lets that work
# as the mapped UID instead of root.
ENV NODE_ENV=production \
    HOME=/home/paboot \
    NPM_CONFIG_PREFIX=/home/paboot/.npm-global \
    PATH=/home/paboot/.npm-global/bin:$PATH \
    PABOOT_HOST=0.0.0.0 \
    PABOOT_PORT=4780 \
    DISABLE_AUTOUPDATER=1

# HOME must stay writable for whichever UID compose maps the container to:
# the agent CLIs write session state, caches and auth refreshes under it.
# These are named-volume mount points; pre-create them with the right mode so a
# fresh volume inherits 777 instead of Docker's root-owned 755.
RUN mkdir -p /home/paboot/.paboot /home/paboot/.npm-global \
      /home/paboot/.claude /home/paboot/.codex /home/paboot/.dsh \
 && chmod 777 /home/paboot /home/paboot/.paboot /home/paboot/.npm-global \
      /home/paboot/.claude /home/paboot/.codex /home/paboot/.dsh

WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json .env.example ./
# COPY preserves host file modes; the container may run as an arbitrary UID.
RUN chmod -R a+rX /app

EXPOSE 4780

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PABOOT_PORT||4780)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/index.js"]
