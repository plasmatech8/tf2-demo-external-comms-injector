//! SteamID parsing helpers (STEAM_X:Y:Z and steamid64).

use thiserror::Error;

#[derive(Debug, Error)]
pub enum SteamIdError {
    #[error("unrecognized steam id format: {0}")]
    Unrecognized(String),
}

/// Parse a SteamID from common string forms into a steamid64.
///
/// Accepts:
/// - `7656119…` (steamid64)
/// - `STEAM_0:Y:Z` / `STEAM_1:Y:Z`
/// - `[U:1:account]`
pub fn parse_steam_id(input: &str) -> Result<u64, SteamIdError> {
    let s = input.trim();
    if let Ok(id) = s.parse::<u64>() {
        if id >= 76561197960265728 {
            return Ok(id);
        }
        // bare account id
        return Ok(id as u64 + 76561197960265728);
    }
    if let Some(rest) = s.strip_prefix("STEAM_") {
        // STEAM_X:Y:Z
        let parts: Vec<&str> = rest.split(':').collect();
        if parts.len() == 3 {
            let y: u64 = parts[1]
                .parse()
                .map_err(|_| SteamIdError::Unrecognized(s.to_string()))?;
            let z: u64 = parts[2]
                .parse()
                .map_err(|_| SteamIdError::Unrecognized(s.to_string()))?;
            return Ok(z * 2 + y + 76561197960265728);
        }
    }
    if let Some(inner) = s.strip_prefix("[U:1:") {
        if let Some(account) = inner.strip_suffix(']') {
            let account: u64 = account
                .parse()
                .map_err(|_| SteamIdError::Unrecognized(s.to_string()))?;
            return Ok(account + 76561197960265728);
        }
    }
    Err(SteamIdError::Unrecognized(s.to_string()))
}

pub fn steam_id_to_u64(input: &str) -> Result<u64, SteamIdError> {
    parse_steam_id(input)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_steamid64() {
        assert_eq!(parse_steam_id("76561198024494988").unwrap(), 76561198024494988);
    }

    #[test]
    fn parse_steam2() {
        // STEAM_0:1:32114630 -> 76561198024494989? Let's compute: 32114630*2+1+76561197960265728
        let id = parse_steam_id("STEAM_0:0:32114630").unwrap();
        assert_eq!(id, 32114630 * 2 + 76561197960265728);
    }

    #[test]
    fn parse_account_bracket() {
        assert_eq!(parse_steam_id("[U:1:64229260]").unwrap(), 64229260 + 76561197960265728);
    }
}
