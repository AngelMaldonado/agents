# The egress proxy of a person's API keys (#24): mitmproxy + the agents addon. It sits on the
# sandbox network; sandboxes reach it as http://run:<token>@<this>:8080 and trust its CA.
# Dev (arm64, reko-2): just proxy build. Prod: not deployed yet (Bubble agents #24).
FROM mitmproxy/mitmproxy:12.1.2

COPY --chmod=0555 entrypoint.sh /usr/local/bin/agents-proxy
COPY --chmod=0444 agents.py swap.py /opt/agents-proxy/

EXPOSE 8080
ENTRYPOINT ["agents-proxy"]
