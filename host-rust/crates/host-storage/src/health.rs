//! Disk health: SMART counters, temperature and wear of the NVMe, and the alerts they raise.
//!
//! The probe is a trait. The real one asks Windows (`Get-PhysicalDisk` and `Get-StorageReliabilityCounter`
//! through PowerShell, read-only); some of those counters need elevation, so every field is optional and
//! an unavailable probe is an answer ("unknown"), not a failure and never a reason to delete anything.
//! The alert rules are plain thresholds a person can read.

use crate::error::StorageError;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiskHealth {
    pub name: String,
    pub temperature_c: Option<u32>,
    pub wear_percent: Option<u32>,
    pub read_errors: Option<u64>,
    pub write_errors: Option<u64>,
    pub power_on_hours: Option<u64>,
    /// Windows' own verdict: `Healthy`, `Warning`, `Unhealthy`.
    pub health: String,
    pub operational: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    Warning,
    Critical,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Alert {
    pub disk: String,
    pub severity: Severity,
    pub message: String,
}

#[derive(Clone, Copy, Debug)]
pub struct Thresholds {
    pub temperature_warning_c: u32,
    pub temperature_critical_c: u32,
    pub wear_warning_percent: u32,
    pub wear_critical_percent: u32,
}

impl Default for Thresholds {
    fn default() -> Self {
        Thresholds { temperature_warning_c: 70, temperature_critical_c: 80, wear_warning_percent: 80, wear_critical_percent: 95 }
    }
}

pub trait DiskHealthProbe: Send + Sync {
    fn probe(&self) -> Result<Vec<DiskHealth>, StorageError>;
}

fn number(value: &Value, key: &str) -> Option<u64> {
    value.get(key).and_then(|v| v.as_u64().or_else(|| v.as_f64().filter(|f| *f >= 0.0).map(|f| f as u64)))
}

/// The JSON `ConvertTo-Json` prints: an array, or a bare object when there is a single disk.
pub fn parse_health_json(text: &str) -> Result<Vec<DiskHealth>, StorageError> {
    let trimmed = text.trim();

    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let value: Value = serde_json::from_str(trimmed).map_err(|error| StorageError::Io(format!("the disk health report is not JSON: {error}")))?;
    let items = match value {
        Value::Array(items) => items,
        other => vec![other],
    };

    Ok(items
        .iter()
        .map(|item| DiskHealth {
            name: item.get("Name").and_then(Value::as_str).unwrap_or("unknown disk").to_string(),
            temperature_c: number(item, "Temperature").map(|n| n as u32),
            wear_percent: number(item, "Wear").map(|n| n as u32),
            read_errors: number(item, "ReadErrors"),
            write_errors: number(item, "WriteErrors"),
            power_on_hours: number(item, "PowerOnHours"),
            health: item.get("Health").and_then(Value::as_str).unwrap_or("Unknown").to_string(),
            operational: item.get("Operational").and_then(Value::as_str).unwrap_or("Unknown").to_string(),
        })
        .collect())
}

/// Thresholds and verdicts, turned into the alerts a person sees. A field the probe could not read raises nothing.
pub fn evaluate(disks: &[DiskHealth], thresholds: &Thresholds) -> Vec<Alert> {
    let mut alerts = Vec::new();

    for disk in disks {
        let mut raise = |severity: Severity, message: String| alerts.push(Alert { disk: disk.name.clone(), severity, message });

        match disk.health.as_str() {
            "Healthy" | "Unknown" => {}
            "Warning" => raise(Severity::Warning, "Windows reports this disk's health as Warning".into()),
            other => raise(Severity::Critical, format!("Windows reports this disk's health as {other}")),
        }

        if let Some(temperature) = disk.temperature_c {
            if temperature >= thresholds.temperature_critical_c {
                raise(Severity::Critical, format!("temperature {temperature} °C (critical from {})", thresholds.temperature_critical_c));
            } else if temperature >= thresholds.temperature_warning_c {
                raise(Severity::Warning, format!("temperature {temperature} °C (warning from {})", thresholds.temperature_warning_c));
            }
        }

        if let Some(wear) = disk.wear_percent {
            if wear >= thresholds.wear_critical_percent {
                raise(Severity::Critical, format!("{wear}% of the endurance used (critical from {}%)", thresholds.wear_critical_percent));
            } else if wear >= thresholds.wear_warning_percent {
                raise(Severity::Warning, format!("{wear}% of the endurance used (warning from {}%)", thresholds.wear_warning_percent));
            }
        }

        for (label, count) in [("read", disk.read_errors), ("write", disk.write_errors)] {
            if let Some(count) = count.filter(|c| *c > 0) {
                raise(Severity::Warning, format!("{count} uncorrected {label} errors"));
            }
        }
    }

    alerts.sort_by(|a, b| b.severity.cmp(&a.severity).then(a.disk.cmp(&b.disk)));

    alerts
}

/// Asks Windows, read-only.
#[derive(Debug, Default, Clone, Copy)]
pub struct PowerShellProbe;

const SCRIPT: &str = "$ErrorActionPreference='SilentlyContinue'; Get-PhysicalDisk | ForEach-Object { $d=$_; $r=$d | Get-StorageReliabilityCounter; \
[pscustomobject]@{ Name=$d.FriendlyName; Health=[string]$d.HealthStatus; Operational=[string]$d.OperationalStatus; Temperature=$r.Temperature; Wear=$r.Wear; \
ReadErrors=$r.ReadErrorsUncorrected; WriteErrors=$r.WriteErrorsUncorrected; PowerOnHours=$r.PowerOnHours } } | ConvertTo-Json -Compress";

impl DiskHealthProbe for PowerShellProbe {
    fn probe(&self) -> Result<Vec<DiskHealth>, StorageError> {
        let output = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", SCRIPT])
            .output()
            .map_err(|error| StorageError::Io(format!("cannot run PowerShell: {error}")))?;

        if !output.status.success() {
            return Err(StorageError::Io(format!("the disk health query failed: {}", String::from_utf8_lossy(&output.stderr).trim())));
        }

        parse_health_json(&String::from_utf8_lossy(&output.stdout))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_an_array_a_single_object_and_nothing() {
        let one = r#"{"Name":"Samsung SSD 990 PRO","Health":"Healthy","Operational":"OK","Temperature":41,"Wear":3,"ReadErrors":0,"WriteErrors":0,"PowerOnHours":812}"#;
        let disks = parse_health_json(one).unwrap();

        assert_eq!(disks.len(), 1);
        assert_eq!((disks[0].temperature_c, disks[0].wear_percent, disks[0].power_on_hours), (Some(41), Some(3), Some(812)));
        assert_eq!(parse_health_json(&format!("[{one},{one}]")).unwrap().len(), 2);
        assert!(parse_health_json("  ").unwrap().is_empty());
        assert!(parse_health_json("not json").is_err());
    }

    #[test]
    fn missing_counters_are_unknown_not_zero() {
        let disks = parse_health_json(r#"{"Name":"d","Health":"Healthy","Operational":"OK","Temperature":null}"#).unwrap();

        assert_eq!(disks[0].temperature_c, None);
        assert!(evaluate(&disks, &Thresholds::default()).is_empty(), "no reading, no alert");
    }

    fn disk(temperature: Option<u32>, wear: Option<u32>, errors: Option<u64>, health: &str) -> DiskHealth {
        DiskHealth {
            name: "nvme0".into(),
            temperature_c: temperature,
            wear_percent: wear,
            read_errors: errors,
            write_errors: None,
            power_on_hours: None,
            health: health.into(),
            operational: "OK".into(),
        }
    }

    #[test]
    fn thresholds_raise_the_right_severity() {
        let t = Thresholds::default();

        assert!(evaluate(&[disk(Some(40), Some(5), Some(0), "Healthy")], &t).is_empty());
        assert_eq!(evaluate(&[disk(Some(70), None, None, "Healthy")], &t)[0].severity, Severity::Warning);
        assert_eq!(evaluate(&[disk(Some(80), None, None, "Healthy")], &t)[0].severity, Severity::Critical);
        assert_eq!(evaluate(&[disk(None, Some(80), None, "Healthy")], &t)[0].severity, Severity::Warning);
        assert_eq!(evaluate(&[disk(None, Some(95), None, "Healthy")], &t)[0].severity, Severity::Critical);
        assert_eq!(evaluate(&[disk(None, None, Some(3), "Healthy")], &t)[0].severity, Severity::Warning);
        assert_eq!(evaluate(&[disk(None, None, None, "Unhealthy")], &t)[0].severity, Severity::Critical);

        let mixed = evaluate(&[disk(Some(72), Some(97), None, "Healthy")], &t);

        assert_eq!(mixed.iter().map(|a| a.severity).collect::<Vec<_>>(), vec![Severity::Critical, Severity::Warning], "the worst alert first");
    }
}
