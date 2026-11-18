//! A tiny `--key value` parser, so the tool needs no CLI crate.

use std::collections::HashMap;
use std::str::FromStr;

use anyhow::{Context, bail};

pub struct Args {
    values: HashMap<String, String>,
}

impl Args {
    /// Parse `--key value`, `--key=value` and bare `--flag`. `known` lists
    /// every accepted key, so a typo fails instead of being ignored.
    pub fn parse(raw: &[String], known: &[&str]) -> anyhow::Result<Self> {
        let mut values = HashMap::new();
        let mut i = 0;
        while i < raw.len() {
            let Some(arg) = raw[i].strip_prefix("--") else {
                bail!("unexpected argument {:?}", raw[i]);
            };
            let (key, value) = match arg.split_once('=') {
                Some((k, v)) => (k.to_string(), v.to_string()),
                None => match raw.get(i + 1) {
                    Some(next) if !next.starts_with("--") => {
                        i += 1;
                        (arg.to_string(), next.clone())
                    }
                    _ => (arg.to_string(), "true".to_string()),
                },
            };
            if key != "help" && !known.contains(&key.as_str()) {
                bail!("unknown option --{key}");
            }
            values.insert(key, value);
            i += 1;
        }
        Ok(Self { values })
    }

    pub fn help(&self) -> bool {
        self.values.contains_key("help")
    }

    pub fn str(&self, key: &str) -> Option<&str> {
        self.values.get(key).map(String::as_str)
    }

    pub fn str_or<'a>(&'a self, key: &str, default: &'a str) -> &'a str {
        self.str(key).unwrap_or(default)
    }

    pub fn flag(&self, key: &str) -> bool {
        matches!(self.str(key), Some("true" | "1" | "yes"))
    }

    pub fn num<T: FromStr>(&self, key: &str, default: T) -> anyhow::Result<T>
    where
        T::Err: std::fmt::Display,
    {
        match self.str(key) {
            None => Ok(default),
            Some(v) => v
                .parse::<T>()
                .map_err(|e| anyhow::anyhow!("{e}"))
                .with_context(|| format!("--{key} {v:?}")),
        }
    }
}
