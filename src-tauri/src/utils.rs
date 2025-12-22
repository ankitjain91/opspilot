
#![allow(dead_code)]
use k8s_openapi::api::core::v1 as k8s_core;
use k8s_openapi::api::apps::v1 as k8s_apps;
use k8s_openapi::api::batch::v1 as k8s_batch;

pub mod logging;

pub fn topo_node_id(kind: &str, namespace: Option<&str>, name: &str) -> String {
    if let Some(ns) = namespace { format!("{}/{}/{}", kind, ns, name) } else { format!("{}/{}", kind, name) }
}

pub fn derive_pod_status(pod: &k8s_core::Pod) -> String {
    if let Some(status) = &pod.status {
        if let Some(phase) = &status.phase {
            match phase.as_str() {
                "Running" => {
                    // Check conditions ready
                    if let Some(conds) = &status.conditions {
                        if conds.iter().any(|c| c.type_ == "Ready" && c.status == "True") { return "Healthy".into(); }
                    }
                    "Degraded".into()
                },
                "Pending" => "Pending".into(),
                "Failed" => "Failed".into(),
                _ => "Unknown".into(),
            }
        } else { "Unknown".into() }
    } else { "Unknown".into() }
}

pub fn derive_deployment_status(dep: &k8s_apps::Deployment) -> String {
    let spec_repl = dep.spec.as_ref().and_then(|s| s.replicas).unwrap_or(0);
    let avail = dep.status.as_ref().and_then(|s| s.available_replicas).unwrap_or(0);
    if spec_repl == 0 { return "Unknown".into(); }
    if avail == spec_repl { "Healthy".into() } else { "Degraded".into() }
}

pub fn derive_stateful_status(st: &k8s_apps::StatefulSet) -> String {
    let desired = st.spec.as_ref().and_then(|s| s.replicas).unwrap_or(0);
    let ready = st.status.as_ref().and_then(|s| s.ready_replicas).unwrap_or(0);
    if desired == 0 { return "Unknown".into(); }
    if desired == ready { "Healthy".into() } else { "Degraded".into() }
}

pub fn derive_daemon_status(ds: &k8s_apps::DaemonSet) -> String {
    let desired = ds.status.as_ref().map(|s| s.desired_number_scheduled).unwrap_or(0);
    let ready = ds.status.as_ref().map(|s| s.number_ready).unwrap_or(0);
    if desired == 0 { return "Unknown".into(); }
    if desired == ready { "Healthy".into() } else { "Degraded".into() }
}

pub fn derive_job_status(job: &k8s_batch::Job) -> String {
    if let Some(status) = &job.status {
        if let Some(succeeded) = status.succeeded { if succeeded > 0 { return "Healthy".into(); } }
        if status.failed.unwrap_or(0) > 0 { return "Failed".into(); }
        return "Pending".into();
    }
    "Unknown".into()
}

pub fn parse_cpu_to_milli(cpu: &str) -> u64 {
    if cpu.ends_with('m') {
        cpu.trim_end_matches('m').parse::<u64>().unwrap_or(0)
    } else if cpu.ends_with('n') {
        cpu.trim_end_matches('n').parse::<u64>().unwrap_or(0) / 1_000_000
    } else {
        // Assume cores
        (cpu.parse::<f64>().unwrap_or(0.0) * 1000.0) as u64
    }
}

pub fn parse_memory_to_bytes(memory: &str) -> u64 {
    let memory = memory.trim();
    if memory.ends_with("Ki") {
        memory.trim_end_matches("Ki").parse::<u64>().unwrap_or(0) * 1024
    } else if memory.ends_with("Mi") {
        memory.trim_end_matches("Mi").parse::<u64>().unwrap_or(0) * 1024 * 1024
    } else if memory.ends_with("Gi") {
        memory.trim_end_matches("Gi").parse::<u64>().unwrap_or(0) * 1024 * 1024 * 1024
    } else if memory.ends_with("Ti") {
        memory.trim_end_matches("Ti").parse::<u64>().unwrap_or(0) * 1024 * 1024 * 1024 * 1024
    } else {
        memory.parse::<u64>().unwrap_or(0)
    }
}

pub fn format_cpu(nano: u64) -> String {
    if nano >= 1_000_000_000 {
        format!("{:.2}", nano as f64 / 1_000_000_000.0)
    } else if nano >= 1_000_000 {
        format!("{}m", nano / 1_000_000)
    } else if nano >= 1000 {
        format!("{}u", nano / 1000)
    } else {
        format!("{}n", nano)
    }
}

pub fn format_memory(bytes: u64) -> String {
    if bytes >= 1024 * 1024 * 1024 {
        format!("{:.2}Gi", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    } else if bytes >= 1024 * 1024 {
        format!("{:.2}Mi", bytes as f64 / (1024.0 * 1024.0))
    } else if bytes >= 1024 {
        format!("{:.2}Ki", bytes as f64 / 1024.0)
    } else {
        format!("{}B", bytes)
    }
}
