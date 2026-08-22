# Dedicated AP configuration checklist

The Home CSI nodes associate to a **spare consumer router acting as a
dedicated access point**, separate from the home's normal WiFi. You
configure this through the router's web GUI — there is no config file to
template, so this is a precise, checkbox-style operator checklist instead.
Menu names below are generic (vendors differ); look for the nearest
equivalent setting.

Every item states the setting **and the reason**, because several of these
will look like "why does this matter" unless you know the CSI/AEAD context.

## 1. Channel and bandwidth (dedicated AP)

- [ ] **Fix the WiFi channel to one specific 2.4 GHz channel** (pick one of
      1, 6, or 11 to avoid adjacent-channel overlap with the home AP — see
      §2). **Disable auto-channel selection / "Smart Channel" / "Auto
      (recommended)".**
      *Why:* a channel change mid-deployment silently invalidates all
      captured data — CSI is channel-specific, and a background auto-channel
      hop would splice incompatible data into the same stream with no
      obvious signal that it happened.
- [ ] **Force 20 MHz channel width.** Disable 40 MHz mode / "channel
      bonding" / "Auto 20/40 MHz".
      *Why:* CSI dimensionality (subcarrier count/layout) changes with
      channel bandwidth (see `docs/protocol.md` §9.2 `bandwidth` field —
      this deployment is fixed to 20 MHz/`HT20`). Mixing bandwidths would
      corrupt comparability between records and between nodes.

## 2. Radio mode and band

- [ ] **Set wireless mode to 802.11b/g/n** (sometimes labeled "Mixed
      b/g/n" or "2.4 GHz only"). **Disable any WiFi 6 / 802.11ax-only mode**
      and any **5 GHz-only** setting.
      *Why:* the Halocode's ESP32 radio only supports 2.4 GHz 802.11n and
      below — an AX-only or 5 GHz-only mode would prevent nodes from
      associating at all, or silently push them onto a rate/PHY the
      firmware's CSI capture path doesn't expect.
- [ ] **If the router is dual-band**, either disable the 5 GHz radio
      entirely, or leave it on for other uses but confirm it is not
      configured as a "combined SSID" / band-steering pair with the 2.4 GHz
      radio (see §3 — band steering must be off regardless).
      *Why:* a shared SSID across bands invites the router to steer clients
      by radio conditions, which is exactly the roaming behavior nodes must
      not be subject to.

## 3. Roaming / steering assistance — must all be OFF

- [ ] **Disable band steering** ("Smart Connect", "Band Steering").
- [ ] **Disable mesh / AP-to-AP roaming features** if this router supports
      them (EasyMesh, proprietary mesh modes).
- [ ] **Disable 802.11k/v/r** (fast roaming / BSS transition management /
      neighbor reports) if exposed as a toggle.
      *Why:* all of the above exist to move a client between radios/APs for
      better signal. Nodes are stationary and must stay associated to one
      specific radio on one specific channel for the whole deployment — any
      of these features could otherwise disassociate/reassociate a node
      without warning, which looks like node data loss for no visible reason.

## 4. Power management

- [ ] **Disable WiFi power-saving / "Eco Mode" / "WMM Power Save"** on the
      AP side.
      *Why:* AP-side power-saving features can delay or buffer traffic to
      sleeping-seeming clients, and some implementations throttle beacon/
      probe timing in ways that degrade CSI sounding-frame availability and
      timing regularity — the opposite of what a continuous-capture sensor
      network needs.

## 5. Security

- [ ] **Set security mode to WPA2-PSK (AES/CCMP).** Do **not** use
      WPA3-only / WPA3-SAE-only mode.
      *Why:* the ESP32's WiFi stack has known, version-dependent association
      problems with WPA3-only networks (SAE handshake support is
      inconsistent across ESP-IDF versions). If the router only offers
      "WPA2/WPA3 Mixed" or "WPA3-Personal", prefer the mixed mode (if
      available) or fall back to WPA2-PSK only — do not select a WPA3-only
      option for this AP.

## 6. Addressing

- [ ] **Set a DHCP static reservation (MAC → IP) for every node.**
      *Why:* stable, predictable IPs make it possible to know which node is
      which in logs/monitoring and to firewall/troubleshoot per-node without
      re-discovering addresses after every reboot.

  Fill in as you provision each node:

  | Node label (room) | MAC address | Reserved IP |
  |--------------------|-------------|-------------|
  |                    |             |             |
  |                    |             |             |
  |                    |             |             |
  |                    |             |             |
  |                    |             |             |
  |                    |             |             |
  |                    |             |             |
  |                    |             |             |
  |                    |             |             |

## 7. The home AP (the *other* network)

- [ ] **Pin the home network's AP to a fixed 2.4 GHz channel too**
      (auto-channel off there as well).
      *Why:* one purpose of this system is passively observing sounding
      frames from existing devices on the home network. If the home AP's
      auto-channel logic hops channels, the dedicated Home CSI AP (fixed on
      its own channel per §1) is no longer on the same channel as the
      traffic it's trying to observe, silently killing passive sniffing with
      no error anywhere in this stack.
  - To find the home AP's **current** channel before pinning it: check the
    router's own status/wireless page (most GUIs show "Current Channel"
    under WiFi status), or use a WiFi scanner app/tool from a laptop/phone
    (e.g. a WiFi analyzer app, or `nmcli dev wifi list` / `iwlist scan` on
    Linux) to see which channel the home SSID is broadcasting on right now.

## 8. Connectivity and client isolation

- [ ] **Confirm the dedicated AP's uplink (WAN or LAN-to-router-with-
      internet) actually reaches the Internet.** Nodes need to reach the VPS
      over the public Internet to send CSI data — a dedicated AP that is
      only a local, disconnected WiFi island won't work.
- [ ] **Client isolation ("AP Isolation" / "Wireless Isolation") must be
      OFF.** This is easy to miss and breaks the system silently — flag it
      prominently and double-check it.
      *Why:* nodes need to hear **each other's** broadcast/multicast
      sounding frames on the same channel to build a useful CSI picture —
      that is the whole point of associating them to a shared dedicated AP.
      Client isolation exists specifically to *block* inter-client traffic
      on consumer routers (a common default-on "security" feature) and
      would silently prevent nodes from ever seeing each other's frames
      while each node still individually appears "connected" — a failure
      mode that gives no obvious error.

## 9. Verification

Once the AP is configured and nodes are provisioned (see
`docs/deployment.md`):

- [ ] **Each node associated**: check the AP's "Connected Devices" /
      "Client List" page and confirm every node's MAC address from your
      table in §6 appears there.
- [ ] **Each node got its reserved IP**: cross-check the IP shown in the
      client list against the table in §6 (not just "got *an* IP" — confirm
      it's the *reserved* one, otherwise your reservation didn't take).
- [ ] **Each node is reaching the VPS**: on the server, run
      `docker compose -f ops/docker-compose.yml logs -f ingest` (or the
      systemd equivalent, `journalctl -u homecsi-ingest -f`) and confirm you
      see datagrams/heartbeats attributed to each node's `node_id` shortly
      after power-on. See `docs/deployment.md` "Troubleshooting" if a node
      associates to the AP but nothing arrives at the server — that points
      at the WAN uplink, the VPS firewall, or the node's PSK/UDP target
      config rather than the AP itself.
