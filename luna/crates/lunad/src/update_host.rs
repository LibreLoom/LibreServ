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
            {
                return true;
            }
            if let Some(v4) = v6.to_ipv4_mapped() {
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
