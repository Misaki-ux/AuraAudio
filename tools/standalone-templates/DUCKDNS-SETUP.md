# Direct DuckDNS + HTTPS setup

DuckDNS updates the hostname only. Caddy runs on this PC, obtains and renews a certificate with the DuckDNS DNS challenge, and proxies HTTPS to the loopback-only AuraAudio API.

## Requirements

- A DuckDNS hostname and token.
- A public IPv4 address and router forwarding (CGNAT may prevent inbound connections).
- Node.js and a DuckDNS-enabled Caddy binary. The launcher prefers the bundled `caddy-duckdns.exe`; otherwise, install a compatible Caddy on `PATH`.
- A reserved LAN address for the server PC.

## Setup

1. Copy `duckdns.config.example.json` to `duckdns.config.json`. Set `domain` to the DuckDNS subdomain only (for example `aurahome`, without `.duckdns.org`) and `token` to the DuckDNS account token. Keep this file private; it is ignored by Git.
2. Reserve the PC's LAN address. Forward external TCP port `32768` to this PC's local TCP port `443` (the default can be changed with `-HttpsPort`). Allow local TCP port `443` through Windows Firewall. Do not forward the AuraAudio API port.
3. To launch the server and open a one-time QR prompt page for the **autonomous client only**, run `.\start-autonomous-client.ps1`. The launcher waits for the local HTTPS listener (not a loopback connection to the public hostname), then opens a QR prompt in the default browser. To select a different external port, run `.\start-autonomous-client.ps1 -HttpsPort 32769`. The QR opens `/autonomousclientmobile/` and expires after two minutes or its first successful scan. An external claim is accepted only for a QR minted by the access-key-protected HTTPS launcher.
4. Keep the PowerShell window open while using the external client. AuraAudio binds to loopback and DuckDNS updates every five minutes. Restarting the launcher revokes the temporary server key and paired client tokens.
5. If you only need the web URL and access key, use `.\start-duckdns-server.ps1`; that launcher does not generate a pairing QR.

No inbound ports 80 or 443 are needed for ACME validation; Caddy uses DNS-01. The router maps the chosen external HTTPS port to local TCP 443, where Caddy terminates TLS. Caddy's upstream connection to AuraAudio stays on loopback.

If Caddy is already serving another site, run `.\start-autonomous-client.ps1 -ExistingProxy` after adding the printed reverse-proxy site block to your existing proxy configuration. Do not start a second Caddy process. The same router mapping applies.

If startup reports that the DuckDNS module is missing, use the bundled `caddy-duckdns.exe` or build a compatible binary with `build-caddy-duckdns.ps1`. If a certificate cannot be issued, check the DuckDNS hostname/token, DNS propagation, router mapping, Windows Firewall, and CGNAT status.
