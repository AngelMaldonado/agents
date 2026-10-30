FROM ghcr.io/actions/actions-runner:2.338.2
USER root
RUN apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/*
USER runner
WORKDIR /home/runner
# JIT is supplied via ACTIONS_RUNNER_INPUT_JITCONFIG, never a command-line argument.
ENTRYPOINT ["timeout", "75m", "./run.sh"]
