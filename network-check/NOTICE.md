# IP quality engine

`vendor/IPQuality/` contains unmodified source and reference data from
https://github.com/xykt/IPQuality at commit
`ad222ab16778be2a13a174cd1acbd69fb4cac6b7` (v2026-09-04), under AGPL-3.0.
The complete upstream license is in `vendor/IPQuality/LICENSE`.

`ip-quality.sh` is an AGPL-3.0-or-later adapter, added 2026-09-15. It loads only
the upstream function definitions and corrects the JSON IPQS score field at
load time and uses a portable ANSI text cleaner. It fixes the IP family for HTTP requests, uses bundled reference
data, and disables interactive startup, ads, usage counters, dependency
installation and report uploads. SMTP and DNSBL are handled by the Node service
so container NAT is supported and failed DNS lookups are not reported as clean.

The web UI offers `/api/ip-quality/source`, a complete source archive of this
service, its adapter, reference data and licenses, for users of the hosted
checker. The Node server and frontend are original project code under the
repository's MIT license; the shell adapter and upstream retain their license.

Additional adapter fixes: strip terminal colors before region brackets, validate
Prime Video's currentTerritory field (plain or typed value), and report unknown
territories without misclassifying page fragments as country codes. The Node
service masks the exit IP before caching or returning a report; full IPs are
used only internally for probes. IPv4 retains two octets, IPv6 two hextets.
