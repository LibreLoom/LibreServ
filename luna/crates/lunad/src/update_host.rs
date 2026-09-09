//! Host checks for admin-configured update sources (SSRF hardening).

const UPDATE_HOST_ERR: &str = "That API address points at a private or local network. Use a public Forgejo or Gitea address for updates.";

/// True when an update-source host IP must not be contacted (SSRF hardening).
pub(crate) fn is_blocked_update_host_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || is_cgnat_v4(v4)
        }
        std::net::IpAddr::V6(v6) => {
            if v6.is_loopback()
                || v6.is_unique_local()
                || v6.is_unicast_link_local()
                || v6.is_unspecified()
                || v6.is_multicast()
            {
                return true;
            }
            // Cover both IPv4-mapped (::ffff:a.b.c.d) and the deprecated
            // IPv4-compatible form (::a.b.c.d). Checking only mapped left
            // ::127.0.0.1 / ::10.0.0.1 etc. unblocked.
            //
            // Keep the loopback check above: `::1`.to_ipv4() is Some(0.0.0.1),
            // which is not itself a blocked IPv4.
            if let Some(v4) = v6.to_ipv4() {
                return is_blocked_update_host_ip(std::net::IpAddr::V4(v4));
            }
            false
        }
    }
}

pub(crate) fn is_cgnat_v4(v4: std::net::Ipv4Addr) -> bool {
    // 100.64.0.0/10 shared-address space
    let o = v4.octets();
    o[0] == 100 && (o[1] & 0xc0) == 64
}

/// Hostname (no port) from an http(s) api_base. Plain-language errors for the UI.
pub(crate) fn api_base_hostname(api_base: &str) -> Result<String, &'static str> {
    let trimmed = api_base.trim();
    let rest = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .ok_or("The API address must start with http:// or https://.")?;
    let authority = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .rsplit('@')
        .next()
        .unwrap_or("");
    let host = if let Some(inner) = authority.strip_prefix('[') {
        let end = inner
            .find(']')
            .ok_or("That API address is missing a closing bracket around the host.")?;
        &inner[..end]
    } else {
        authority.split(':').next().unwrap_or("")
    };
    if host.is_empty() {
        return Err("The API address needs a host name.");
    }
    Ok(host.to_string())
}

/// Reject update sources whose host is localhost, a private/link-local IP, or
/// (when DNS resolves) any address in those ranges.
pub(crate) fn validate_api_base_host(api_base: &str) -> Result<(), &'static str> {
    let host = api_base_hostname(api_base)?;
    if host.eq_ignore_ascii_case("localhost") {
        return Err(UPDATE_HOST_ERR);
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        if is_blocked_update_host_ip(ip) {
            return Err(UPDATE_HOST_ERR);
        }
        return Ok(());
    }
    // Resolve when possible. NXDOMAIN / temporary DNS failure is not a hard
    // reject here — the later fetch will surface a reachability error.
    let lookup = format!("{host}:443");
    if let Ok(addrs) = std::net::ToSocketAddrs::to_socket_addrs(&lookup) {
        let mut saw_any = false;
        for addr in addrs {
            saw_any = true;
            if is_blocked_update_host_ip(addr.ip()) {
                return Err(UPDATE_HOST_ERR);
            }
        }
        let _ = saw_any;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::IpAddr;

    fn ip(s: &str) -> IpAddr {
        s.parse().expect(s)
    }

    #[test]
    fn blocks_v4_private_and_special() {
        assert!(is_blocked_update_host_ip(ip("127.0.0.1")));
        assert!(is_blocked_update_host_ip(ip("10.0.0.1")));
        assert!(is_blocked_update_host_ip(ip("192.168.1.1")));
        assert!(is_blocked_update_host_ip(ip("169.254.1.1")));
        assert!(is_blocked_update_host_ip(ip("100.64.0.1")));
        assert!(is_blocked_update_host_ip(ip("0.0.0.0")));
        assert!(!is_blocked_update_host_ip(ip("8.8.8.8")));
    }

    #[test]
    fn blocks_v6_mapped_and_compatible_private() {
        // IPv4-mapped (already covered before this fix).
        assert!(is_blocked_update_host_ip(ip("::ffff:127.0.0.1")));
        assert!(is_blocked_update_host_ip(ip("::ffff:10.1.2.3")));
        assert!(is_blocked_update_host_ip(ip("::ffff:192.168.0.9")));
        // Deprecated IPv4-compatible form — the gap this patch closes.
        assert!(is_blocked_update_host_ip(ip("::127.0.0.1")));
        assert!(is_blocked_update_host_ip(ip("::10.0.0.1")));
        assert!(is_blocked_update_host_ip(ip("::192.168.1.1")));
        assert!(is_blocked_update_host_ip(ip("::169.254.169.254")));
        assert!(is_blocked_update_host_ip(ip("::100.64.1.2")));
        // Public mapped/compatible stay allowed.
        assert!(!is_blocked_update_host_ip(ip("::ffff:8.8.8.8")));
        assert!(!is_blocked_update_host_ip(ip("::8.8.8.8")));
    }

    #[test]
    fn blocks_native_v6_local_ranges() {
        assert!(is_blocked_update_host_ip(ip("::1")));
        assert!(is_blocked_update_host_ip(ip("fc00::1")));
        assert!(is_blocked_update_host_ip(ip("fe80::1")));
        assert!(is_blocked_update_host_ip(ip("ff02::1")));
        assert!(!is_blocked_update_host_ip(ip("2001:4860:4860::8888")));
    }

    #[test]
    fn validate_rejects_compatible_literal_in_api_base() {
        assert!(validate_api_base_host("http://[::192.168.0.1]/api/v1").is_err());
        assert!(validate_api_base_host("https://[::ffff:10.0.0.1]/api/v1").is_err());
        assert!(validate_api_base_host("http://[::1]/api/v1").is_err());
        assert!(validate_api_base_host("https://8.8.8.8/api/v1").is_ok());
    }
}
