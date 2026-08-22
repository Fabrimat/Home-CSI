#!/usr/bin/env bash
#
# Home CSI — VPS hardening script.
#
# Target: a fresh Debian/Ubuntu VPS (tested assumption: Debian 12 / Ubuntu
# 22.04+; adjust package names if your distro differs). Linux-only - this is
# meant to run ON the VPS over SSH, not on the Windows-on-ARM dev machine.
#
# Design goals:
#   - Idempotent: safe to run more than once. Every step checks current
#     state before changing anything and skips if already applied.
#   - Not silently destructive: nothing here overwrites a config file
#     without first backing it up (suffix `.bak-homecsi`), and the riskiest
#     step (SSH hardening, which can lock you out) is OFF BY DEFAULT and
#     requires an explicit flag plus a typed confirmation.
#   - Read this whole script before running it. It is intended to be read,
#     not blindly piped into `bash`.
#
# Usage:
#   sudo ./harden.sh                 # firewall, fail2ban, unattended
#                                     # upgrades, NTP, Docker install,
#                                     # UDP rate limiting. Does NOT touch
#                                     # sshd_config.
#   sudo ./harden.sh --harden-ssh    # additionally disables SSH password
#                                     # auth and root login. READ THE
#                                     # WARNING BELOW FIRST.
#
# Environment variables (export before running, or source ops/.env first -
# see ops/hardening/README.md for the exact one-liner):
#   HOMECSI_UDP_PORT               - the ingest UDP port to allow through the
#                                     firewall (must match ops/.env's
#                                     HOMECSI_UDP_PORT). Default: 5566.
#   HOMECSI_UDP_RATE_LIMIT_PER_SEC - sustained per-source-IP packet ceiling
#                                     for the UDP rate limiter, in packets/
#                                     second. Default: 1000. See section 3
#                                     below for the arithmetic behind this
#                                     default and when to raise it (e.g.
#                                     going from 4 to 9 nodes).
#   HOMECSI_UDP_RATE_LIMIT_BURST   - burst allowance (packet count) on top
#                                     of the sustained ceiling above.
#                                     Default: 2000. See section 3.
#
# Re-running this script after changing either rate-limit variable DOES
# update the live firewall rule (the block is replaced in place, not just
# skipped because "it's already there") - see section 3 for how.
#
# See the companion doc, ops/hardening/README.md, for the reasoning behind
# each section and what is deliberately out of scope.

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults / config
# ---------------------------------------------------------------------------

HOMECSI_UDP_PORT="${HOMECSI_UDP_PORT:-5566}"
HOMECSI_UDP_RATE_LIMIT_PER_SEC="${HOMECSI_UDP_RATE_LIMIT_PER_SEC:-1000}"
HOMECSI_UDP_RATE_LIMIT_BURST="${HOMECSI_UDP_RATE_LIMIT_BURST:-2000}"
HARDEN_SSH=0

for arg in "$@"; do
  case "$arg" in
    --harden-ssh) HARDEN_SSH=1 ;;
    -h|--help)
      sed -n '1,40p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "This script must be run as root (e.g. via sudo)." >&2
  exit 1
fi

log() { echo "[harden] $*"; }
backup_once() {
  # Back up a config file the first time we touch it; no-op on subsequent runs.
  local f="$1"
  if [ -f "$f" ] && [ ! -f "${f}.bak-homecsi" ]; then
    cp -a "$f" "${f}.bak-homecsi"
    log "Backed up $f -> ${f}.bak-homecsi"
  fi
}

log "=============================================================="
log " Home CSI VPS hardening"
log " UDP ingest port to allow: ${HOMECSI_UDP_PORT}"
log " UDP rate limit: ${HOMECSI_UDP_RATE_LIMIT_PER_SEC}/sec, burst ${HOMECSI_UDP_RATE_LIMIT_BURST}"
log " SSH hardening requested: $([ "$HARDEN_SSH" -eq 1 ] && echo yes || echo no)"
log "=============================================================="

# ---------------------------------------------------------------------------
# 0. Prominent warning + confirmation gate
# ---------------------------------------------------------------------------
#
# This step exists so the operator cannot accidentally run this script via
# a pipe (`curl ... | bash`) without seeing the warning. It is a real
# terminal prompt, not just a comment.

cat <<'EOF'

*******************************************************************
* WARNING - READ BEFORE CONTINUING                                *
*                                                                  *
* This script changes the VPS firewall and (if --harden-ssh was   *
* passed) SSH authentication settings. A mistake here can lock    *
* you out of the machine entirely, requiring console/rescue-mode  *
* access from your VPS provider to fix.                           *
*                                                                  *
* Before continuing:                                               *
*   1. Confirm you are connected over SSH using a KEY (not a       *
*      password) - `--harden-ssh` disables password auth.          *
*   2. Keep this SSH session open. After this script finishes,     *
*      open a SECOND, separate SSH session and confirm you can     *
*      still log in BEFORE closing the first session.              *
*   3. Know your VPS provider's console/rescue access path in case *
*      something does go wrong.                                    *
*******************************************************************

EOF

read -r -p "Type 'yes' to continue: " confirm
if [ "$confirm" != "yes" ]; then
  log "Aborted by operator."
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Base packages
# ---------------------------------------------------------------------------

log "Updating package index and installing base tooling..."
apt-get update -y
apt-get install -y --no-install-recommends \
  ufw \
  fail2ban \
  unattended-upgrades \
  apt-listchanges \
  chrony \
  ca-certificates \
  curl \
  gnupg

# ---------------------------------------------------------------------------
# 2. Firewall (ufw) - default deny inbound, allow SSH/80/443/UDP ingest
# ---------------------------------------------------------------------------
#
# We pick ufw (not raw nftables) for readability/idempotency: `ufw status`
# gives a clear, re-checkable picture of current rules, and `ufw allow` is
# safe to re-run. See the "UDP rate limiting" section below for where we
# drop to raw iptables rules (ufw's underlying engine on Debian/Ubuntu)
# because ufw's own rule language cannot express per-source packet-rate
# limiting for UDP by itself.

log "Configuring ufw..."
# No `ufw reset` here on purpose: reset wipes all rules and transiently
# disables enforcement, which is unnecessary churn on a re-run and works
# against "idempotent, not disruptive". ufw already treats `default` and
# `allow` as safe to repeat - it detects and skips exact duplicate rules
# ("Skipping adding existing rule") rather than adding another copy - so
# simply re-asserting the desired state below is sufficient on every run.
ufw default deny incoming
ufw default allow outgoing

# SSH first and always - never remove this rule before disabling password
# auth, or you can lock yourself out.
ufw allow 22/tcp comment 'SSH'

ufw allow 80/tcp comment 'HTTP (Caddy ACME challenge + redirect)'
ufw allow 443/tcp comment 'HTTPS (Caddy, terminates the debug API/UI)'

# The ingest UDP port IS intentionally world-reachable. Every datagram that
# arrives is ChaCha20-Poly1305 AEAD-authenticated with a per-node key
# (docs/protocol.md); anything that isn't a byte-for-byte valid, correctly
# keyed datagram is dropped cheaply by the ingest process (auth tag check
# fails before any further parsing). There is no VPN in v1 (planned later,
# see docs/deployment.md "future: WireGuard VPN"), so this is v1's accepted
# exposure, not an oversight.
ufw allow "${HOMECSI_UDP_PORT}/udp" comment 'Home CSI ingest (AEAD-authenticated, safe to expose)'

ufw --force enable
ufw status verbose

# ---------------------------------------------------------------------------
# 3. UDP rate limiting / abuse containment on the ingest port
# ---------------------------------------------------------------------------
#
# What this protects against: a single source IP sending a sustained flood
# of UDP packets at the ingest port well above anything this deployment's
# real traffic could ever look like, wasting CPU on AEAD-open failures and
# filling logs/metrics. It uses iptables' hashlimit match (available on
# Debian/Ubuntu by default), inserted into ufw's own rule chain so it
# composes with the `ufw allow` rule above rather than fighting it.
#
# IMPORTANT - this hashlimits every packet in the stream, not just
# connection establishment. There is deliberately no `-m state --state NEW`
# qualifier: conntrack's "NEW" state for one-way, fire-and-forget UDP
# telemetry (docs/protocol.md - no ack, no reply, ever) would only match the
# first packet of each 5-tuple's conntrack entry, then treat every
# subsequent packet on that same flow as "ESTABLISHED" until the conntrack
# entry times out - which would make the limiter blind to an actual ongoing
# flood on an already-established flow. So this rule counts and can act on
# every single packet that reaches it, by design.
#
# --- Sizing arithmetic (HOMECSI_UDP_RATE_LIMIT_PER_SEC / _BURST defaults) ---
# Design envelope (docs/architecture.md): 4 nodes now, up to 9 later, each
# capturing at tens of Hz, batched into small UDP datagrams
# (docs/protocol.md section 11: max 1200 bytes/datagram), for a stated
# aggregate throughput of ~110 kbps at 4 nodes rising to ~600 kbps at 9.
#
# We size against the 9-node aggregate, arriving from ONE shared WAN IP
# (see "granularity" note below), using a deliberately small assumed average
# packet size (worse case for a *packet-count* limiter, since smaller
# average packets mean more packets for the same bit rate):
#   600,000 bits/sec / 8                        = 75,000 bytes/sec
#   75,000 bytes/sec / 300 bytes/pkt (assumed)   = 250 packets/sec, sustained,
#                                                   aggregate, 9-node full load
# We then apply a 4x headroom multiple on top of that 250 pps estimate to
# absorb: bursty batch-flush timing (docs/protocol.md's size/count/time
# triggers do not space datagrams evenly), several nodes reconnecting and
# flushing pending batches near-simultaneously after a shared AP hiccup, and
# slop in the 300-byte average-packet-size assumption itself:
#   250 pps x 4                                 = 1000 pps
# -> HOMECSI_UDP_RATE_LIMIT_PER_SEC defaults to 1000 (packets/sec).
# Burst is set to 2 seconds of sustained-ceiling traffic, enough to absorb a
# short synchronized catch-up spike without needing a large standing
# allowance (nodes do not buffer long outages - docs/protocol.md: a node
# that cannot reach the server simply drops or queues-and-drops):
#   1000 pps x 2 sec                            = 2000 packets
# -> HOMECSI_UDP_RATE_LIMIT_BURST defaults to 2000.
# These two numbers are what the DROP rule below actually enforces: each
# packet is evaluated by hashlimit exactly once against the DROP rules own
# bucket (see the "Accounting" note further down, in the Visibility
# section) - there is no double-deduction from a shared bucket diluting the
# 4x headroom multiple or shortening the 2-second burst window computed
# above; both hold as stated.
# If real traffic gets throttled in practice (see the troubleshooting
# command below), raise these two variables in ops/.env and re-run this
# script - it updates the live rule in place, it does not just skip because
# a rule already exists.
#
# --- Granularity: what hashlimit-mode srcip actually buys you here ---
# All nodes sit behind ONE home router and reach the VPS from a single
# public WAN IP. That means `--hashlimit-mode srcip` does NOT give a
# separate bucket per node - it gives exactly one bucket for the entire
# deployment's legitimate traffic (a de facto aggregate ceiling, which is
# what the arithmetic above is sized for), plus a SEPARATE independent
# bucket for any other, unrelated source IP that happens to hit this port.
# srcip mode is kept (rather than a single global/no-mode ceiling)
# specifically for that second property: an unrelated flood source gets
# capped on its own, without being able to consume headroom that was sized
# for the home network's traffic, and without the home network's traffic
# being able to starve out that accounting either.
# What this does NOT do: distinguish "the 9 nodes behaving normally" from
# "a compromised node, or an attacker who has learned the home's WAN IP,
# flooding from that same address" - both share one bucket, by construction,
# because the firewall has no way to tell them apart (same source IP). That
# is a real, inherent limitation of this mechanism, not an oversight; it is
# still meaningfully better than no limit at all, and combined with the
# ingest process's cheap AEAD-based rejection of anything not correctly
# keyed, an attacker on that same IP gains little even while under the cap.
#
# What this does NOT protect against (independent of the above):
#   - A distributed flood (many unrelated source IPs, each under its own
#     per-IP limit). Only the VPS provider's upstream network or a
#     dedicated DDoS mitigation service can meaningfully stop that; this is
#     host-level containment only.
#   - UDP *reflection/amplification* abuse where this host is used as a
#     source of forged-source traffic aimed at a third party. That is a
#     property of any UDP responder; this ingest port sends no response
#     traffic at all in v1 (docs/protocol.md: "no server -> node channel"),
#     which already rules out this service being usable as a reflector -
#     but keep it in mind if the protocol ever grows a reply.
#   - Application-level exhaustion below the rate limit (e.g. a legitimate
#     but misbehaving node stuck retransmitting) - that is a monitoring/
#     alerting problem, not a firewall one.
#
# --- Visibility: so this is observable, not silent packet loss ---
# A LOG rule fires immediately before the DROP rule and is itself throttled
# to 1/minute via a separate, independent `-m limit` match, so a sustained
# flood cannot spam the log:
#   journalctl -k | grep homecsi-udp-limit
#   dmesg | grep homecsi-udp-limit
#
# Accounting (verified against the reasoning in xt_hashlimit, since there
# is no Linux firewall runtime available to execute this and observe it
# directly): the LOG rule uses its OWN hashlimit bucket
# (--hashlimit-name homecsi_udp_log), separate from the DROP rules bucket
# (--hashlimit-name homecsi_udp). This is deliberate, not incidental - an
# earlier version of this script had both rules share one hashlimit-name,
# which meant every packet was charged against the SAME token bucket twice
# (once per rule referencing that name, since every hashlimit match
# unconditionally deducts credit from its named bucket whenever credit is
# available, independent of match/no-match and of any following -m limit
# clause). That silently halved the real ceiling (about 500 pps enforced
# against a documented 1000 pps) without saying so anywhere - exactly the
# defect this comment now documents having fixed.
#
# With two distinct bucket names, each packet is evaluated by hashlimit
# exactly ONCE against homecsi_udp_log (governs only the LOG line) and
# exactly ONCE against homecsi_udp (governs only the DROP line, and is the
# sole enforcement point) - a match or non-match on one name never deducts
# credit from the other, because they are two independent kernel hash
# tables. The DROP rules bucket therefore sees each packet exactly once,
# which is what makes the sizing arithmetic above apply directly and
# without adjustment: the documented 1000 pps ceiling / 2000-packet
# (2 second) burst is what is actually enforced by the DROP rule, not
# halved by an incidental shared-bucket deduction from the LOG rule.
#
# Because both buckets use identical --hashlimit-mode/--hashlimit-above/
# --hashlimit-burst values and observe the identical packet stream (same
# UDP port, same srcip keying), and the LOG rule runs immediately before
# the DROP rule for every packet, the two buckets should trip in lockstep
# in practice - whichever packet first exceeds the LOG bucket is, for all
# practical purposes, the same packet that first exceeds the DROP bucket,
# since both are driven by the same arrival times under the same formula.
# They remain two independent data structures though, so a sub-tick timing
# difference between the two evaluations for the same packet is
# theoretically possible (the log firing one packet before or after the
# drop actually starts) - this is a negligible, disclosed edge case, not a
# correctness issue: the DROP rule is the authoritative enforcement point
# regardless of what the LOG bucket independently decided, so worst case
# the log is off by about one packet relative to the true drop boundary,
# never by a whole bucket-refill interval, and never in the direction of
# under-counting the DROP rules own enforcement.
#
# For live bucket state (current rate estimate per bucketed source):
#   cat /proc/net/ipt_hashlimit/homecsi_udp        # enforcement (DROP) bucket
#   cat /proc/net/ipt_hashlimit/homecsi_udp_log    # LOG-only bucket
# For cumulative hit counters on the DROP rule itself:
#   iptables -L ufw-before-input -v -n | grep "${HOMECSI_UDP_PORT}"
# See docs/deployment.md "Troubleshooting" ("firewall rate limit is eating
# ingest traffic") for the operator-facing version of this.

UFW_BEFORE_RULES=/etc/ufw/before.rules
RATE_LIMIT_BEGIN="# BEGIN HOMECSI UDP RATE LIMIT"
RATE_LIMIT_END="# END HOMECSI UDP RATE LIMIT"

HOMECSI_UDP_RATE_ABOVE="${HOMECSI_UDP_RATE_LIMIT_PER_SEC}/sec"
RATE_LOG_LINE="-A ufw-before-input -p udp --dport ${HOMECSI_UDP_PORT} -m hashlimit --hashlimit-name homecsi_udp_log --hashlimit-mode srcip --hashlimit-above ${HOMECSI_UDP_RATE_ABOVE} --hashlimit-burst ${HOMECSI_UDP_RATE_LIMIT_BURST} -m limit --limit 1/min --limit-burst 1 -j LOG --log-prefix \"[homecsi-udp-limit] \" --log-level 4"
RATE_DROP_LINE="-A ufw-before-input -p udp --dport ${HOMECSI_UDP_PORT} -m hashlimit --hashlimit-name homecsi_udp --hashlimit-mode srcip --hashlimit-above ${HOMECSI_UDP_RATE_ABOVE} --hashlimit-burst ${HOMECSI_UDP_RATE_LIMIT_BURST} -j DROP"

backup_once "$UFW_BEFORE_RULES"

# Idempotent AND updateable: strip any previous Home CSI rate-limit block
# first (rather than skipping entirely if a marker is already present), so
# that changing HOMECSI_UDP_RATE_LIMIT_PER_SEC/_BURST and re-running this
# script actually takes effect instead of a stale rule silently surviving.
if [ -f "$UFW_BEFORE_RULES" ]; then
  awk -v b="$RATE_LIMIT_BEGIN" -v e="$RATE_LIMIT_END" '
    $0 == b { skip=1; next }
    $0 == e { skip=0; next }
    skip != 1 { print }
  ' "$UFW_BEFORE_RULES" > "${UFW_BEFORE_RULES}.stripped"
else
  : > "${UFW_BEFORE_RULES}.stripped"
fi

# Re-insert a fresh block right before the final COMMIT line (before.rules
# is a single *filter table script ending in COMMIT; inserting here loads
# the new rules in the same table/chain pass).
awk -v log_line="$RATE_LOG_LINE" -v drop_line="$RATE_DROP_LINE" \
    -v b="$RATE_LIMIT_BEGIN" -v e="$RATE_LIMIT_END" '
  /^COMMIT$/ && !done {
    print b
    print log_line
    print drop_line
    print e
    done = 1
  }
  { print }
' "${UFW_BEFORE_RULES}.stripped" > "${UFW_BEFORE_RULES}.new"

if ! cmp -s "$UFW_BEFORE_RULES" "${UFW_BEFORE_RULES}.new" 2>/dev/null; then
  mv "${UFW_BEFORE_RULES}.new" "$UFW_BEFORE_RULES"
  rm -f "${UFW_BEFORE_RULES}.stripped"
  log "Updated UDP rate-limit rule in $UFW_BEFORE_RULES (ceiling=${HOMECSI_UDP_RATE_LIMIT_PER_SEC}/sec, burst=${HOMECSI_UDP_RATE_LIMIT_BURST})."
  ufw reload
else
  rm -f "${UFW_BEFORE_RULES}.stripped" "${UFW_BEFORE_RULES}.new"
  log "UDP rate-limit rule already up to date in $UFW_BEFORE_RULES (ceiling=${HOMECSI_UDP_RATE_LIMIT_PER_SEC}/sec, burst=${HOMECSI_UDP_RATE_LIMIT_BURST})."
fi

# ---------------------------------------------------------------------------
# 4. fail2ban for SSH
# ---------------------------------------------------------------------------

log "Configuring fail2ban for sshd..."
JAIL_LOCAL=/etc/fail2ban/jail.local
if [ ! -f "$JAIL_LOCAL" ]; then
  cat > "$JAIL_LOCAL" <<'EOF'
[sshd]
enabled = true
maxretry = 5
bantime = 1h
findtime = 10m
EOF
  log "Created $JAIL_LOCAL"
else
  log "$JAIL_LOCAL already exists, leaving it as-is."
fi
systemctl enable --now fail2ban

# ---------------------------------------------------------------------------
# 5. Unattended security upgrades
# ---------------------------------------------------------------------------

log "Enabling unattended-upgrades..."
dpkg-reconfigure -f noninteractive unattended-upgrades || true
# Ensure the periodic update/upgrade timers are on even if the above no-ops.
cat > /etc/apt/apt.conf.d/20auto-upgrades-homecsi <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

# ---------------------------------------------------------------------------
# 6. Swap file note
# ---------------------------------------------------------------------------
#
# This script does NOT create a swap file automatically - swap sizing
# depends on the VPS's RAM and disk headroom, and silently adding swap on a
# disk-constrained VPS (see docs/deployment.md "Disk management") could be
# counterproductive. If free RAM is tight (Postgres + Node + capture
# buffering), consider a 1-2 GB swap file as a crash-safety margin, not a
# performance feature:
#   sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
#   sudo mkswap /swapfile && sudo swapon /swapfile
#   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
if swapon --show | grep -q .; then
  log "Swap already configured: $(swapon --show --noheadings | tr '\n' ' ')"
else
  log "No swap configured. See the comment above this line in the script for how to add some if needed; not done automatically."
fi

# ---------------------------------------------------------------------------
# 7. NTP / time sync
# ---------------------------------------------------------------------------
#
# The server correlates timestamps across multiple nodes (docs/protocol.md
# §7); if the VPS's own clock drifts, every "wall_clock_us" comparison
# against it is skewed too. chrony (installed above) is enabled here.

log "Enabling chrony for NTP sync..."
systemctl enable --now chrony
sleep 2
chronyc tracking || log "chronyc tracking failed - chrony may still be syncing, check again in a minute with: chronyc tracking"

# ---------------------------------------------------------------------------
# 8. Docker installation
# ---------------------------------------------------------------------------
#
# CRITICAL FOOTGUN: Docker manipulates iptables directly to implement
# published container ports (`ports:` in docker-compose.yml). It inserts
# its own ACCEPT rules ahead of ufw's chain, which means a port published by
# a container can be reachable from the Internet EVEN IF ufw's rules would
# otherwise deny it. ufw's rules and Docker's rules are not automatically
# reconciled - this is a well-known, frequently-hit Docker+ufw interaction,
# not a bug specific to this project.
#
# Why this matters here specifically: ops/docker-compose.yml deliberately
# does NOT publish Postgres's port, precisely so it is unreachable from the
# Internet. That protection holds only as long as no `ports:` entry is ever
# added for the `timescaledb` service - ufw has no say in it either way,
# because Postgres is never published as a Docker port in the first place.
# The real risk is future/accidental publication of a port that SHOULD stay
# internal-only (e.g. someone adds a debug `ports:` line to `api` or
# `timescaledb` temporarily and forgets to remove it) - Docker will happily
# make it Internet-reachable regardless of ufw's "default deny incoming".
#
# Mitigation applied here: install Docker with `iptables: true` (the
# default - do NOT set it to false, that breaks container networking in
# other ways) but ALSO install a default-drop rule in Docker's own
# `DOCKER-USER` chain, which Docker guarantees is consulted before its own
# ACCEPT rules for published ports. We allow established/related traffic
# and traffic on the ports this project intentionally publishes (80, 443,
# the UDP ingest port), and drop everything else that would otherwise reach
# a published container port. This re-establishes an default-deny posture
# for Docker-published ports specifically, so an accidentally-published
# port doesn't silently become world-reachable.
#
# This is a mitigation, not a complete fix: anyone editing this script's
# DOCKER-USER rules or the compose file's `ports:` still needs to
# understand this interaction. Re-run this section after any Docker
# upgrade if you suspect the DOCKER-USER chain was reset (Docker does not
# normally touch DOCKER-USER's rules on upgrade, only recreates the chain
# if missing).

if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker Engine..."
  install -m 0755 -d /etc/apt/keyrings
  if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
    curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  fi
  chmod a+r /etc/apt/keyrings/docker.gpg
  # NOTE: this assumes Debian. On Ubuntu, replace the URL below with
  # https://download.docker.com/linux/ubuntu and $(. /etc/os-release && echo
  # "$VERSION_CODENAME") accordingly.
  ARCH="$(dpkg --print-architecture)"
  CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"
  echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian ${CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
else
  log "Docker already installed, skipping install."
fi

systemctl enable --now docker

log "Applying DOCKER-USER mitigation rules (see comment above)..."
# Idempotent: flush only our own tagged rules, not the whole chain (other
# tooling may also use DOCKER-USER).
DOCKER_USER_MARKER="homecsi-docker-user-guard"
if iptables -L DOCKER-USER -n 2>/dev/null | grep -q "$DOCKER_USER_MARKER"; then
  log "DOCKER-USER guard rules already present, skipping (re-run docker or delete matching rules manually to refresh)."
else
  iptables -I DOCKER-USER -m state --state ESTABLISHED,RELATED -j ACCEPT -m comment --comment "$DOCKER_USER_MARKER"
  iptables -I DOCKER-USER -i lo -j ACCEPT -m comment --comment "$DOCKER_USER_MARKER"
  iptables -I DOCKER-USER -p tcp --dport 80 -j ACCEPT -m comment --comment "$DOCKER_USER_MARKER"
  iptables -I DOCKER-USER -p tcp --dport 443 -j ACCEPT -m comment --comment "$DOCKER_USER_MARKER"
  iptables -I DOCKER-USER -p udp --dport "$HOMECSI_UDP_PORT" -j ACCEPT -m comment --comment "$DOCKER_USER_MARKER"
  # SSH is handled by the host's own sshd, not a container, so it does not
  # need a DOCKER-USER rule - but adding one is harmless if you ever
  # containerize it.
  iptables -A DOCKER-USER -j DROP -m comment --comment "$DOCKER_USER_MARKER"
  log "DOCKER-USER guard rules added. These are NOT persisted across reboot by iptables itself -"
  log "install iptables-persistent (or re-run this script) after every Docker/iptables-affecting change."
fi

apt-get install -y iptables-persistent netfilter-persistent 2>/dev/null || \
  log "iptables-persistent not installed automatically (may need manual 'apt-get install iptables-persistent' with interactive prompts) - without it, DOCKER-USER rules above must be re-applied after reboot."
netfilter-persistent save 2>/dev/null || true

# ---------------------------------------------------------------------------
# 9. SSH hardening (opt-in, --harden-ssh only)
# ---------------------------------------------------------------------------

if [ "$HARDEN_SSH" -eq 1 ]; then
  log "Applying SSH hardening (--harden-ssh was passed)..."
  SSHD_CONFIG=/etc/ssh/sshd_config
  backup_once "$SSHD_CONFIG"

  set_sshd_option() {
    local key="$1" value="$2"
    if grep -qE "^\s*#?\s*${key}\s+" "$SSHD_CONFIG"; then
      sed -i -E "s|^\s*#?\s*${key}\s+.*|${key} ${value}|" "$SSHD_CONFIG"
    else
      echo "${key} ${value}" >> "$SSHD_CONFIG"
    fi
  }

  set_sshd_option PasswordAuthentication no
  set_sshd_option PermitRootLogin no
  set_sshd_option ChallengeResponseAuthentication no
  set_sshd_option KbdInteractiveAuthentication no

  if sshd -t; then
    systemctl reload sshd
    log "sshd config validated and reloaded. VERIFY KEY-BASED LOGIN IN A NEW SESSION NOW."
  else
    log "sshd -t validation FAILED - restoring backup and NOT reloading sshd."
    cp -a "${SSHD_CONFIG}.bak-homecsi" "$SSHD_CONFIG"
    exit 1
  fi
else
  log "Skipping SSH hardening (default). Re-run with --harden-ssh once you have confirmed key-based access works, per the warning at the top of this script."
fi

log "=============================================================="
log " Done. Current ufw status:"
ufw status verbose
log "=============================================================="
log "REMINDER: verify you can open a NEW SSH session before closing this one."
