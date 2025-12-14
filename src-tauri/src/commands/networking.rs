
use tauri::{State, Emitter};
use kube::api::Api;
use crate::state::{AppState, PortForwardSession};
use crate::client::create_client;

#[tauri::command]
pub async fn start_port_forward(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    namespace: String,
    name: String,
    local_port: u16,
    pod_port: u16
) -> Result<String, String> {
    let client = create_client(state.clone()).await?;
    let pods: Api<k8s_openapi::api::core::v1::Pod> = Api::namespaced(client, &namespace);

    let session_id = format!("{}-{}-{}", namespace, name, local_port);

    // Check if already exists
    {
        let pfs = state.port_forwards.lock().unwrap();
        if pfs.contains_key(&session_id) {
            return Err(format!("Port forward for {} on port {} already exists", name, local_port));
        }
    }

    let pods_clone = pods.clone();
    let name_clone = name.clone();
    let _session_id_clone = session_id.clone();
    let app_handle = app.clone();

    // Spawn the listener task
    let handle = tokio::spawn(async move {
        let addr = format!("127.0.0.1:{}", local_port);
        let listener = match tokio::net::TcpListener::bind(&addr).await {
            Ok(l) => l,
            Err(e) => {
                let _ = app_handle.emit("pf_error", format!("Failed to bind to {}: {}", addr, e));
                return;
            }
        };

        loop {
            match listener.accept().await {
                Ok((mut socket, _)) => {
                    let pods = pods_clone.clone();
                    let name = name_clone.clone();
                    
                    tokio::spawn(async move {
                        let mut pf = match pods.portforward(&name, &[pod_port]).await {
                            Ok(pf) => pf,
                            Err(e) => {
                                eprintln!("Failed to start port forward: {}", e);
                                return;
                            }
                        };
                        
                        let mut upstream = match pf.take_stream(pod_port) {
                            Some(s) => s,
                            None => return,
                        };

                        if let Err(e) = tokio::io::copy_bidirectional(&mut socket, &mut upstream).await {
                            eprintln!("Port forward connection error: {}", e);
                        }
                    });
                }
                Err(e) => {
                    eprintln!("Listener accept error: {}", e);
                }
            }
        }
    });

    let session = PortForwardSession {
        id: session_id.clone(),
        pod_name: name,
        namespace,
        local_port,
        pod_port,
        handle,
    };

    state.port_forwards.lock().unwrap().insert(session_id.clone(), session);

    Ok(session_id)
}

#[tauri::command]
pub async fn stop_port_forward(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let mut pfs = state.port_forwards.lock().unwrap();
    if let Some(session) = pfs.remove(&session_id) {
        session.handle.abort();
    }
    Ok(())
}

#[tauri::command]
pub async fn list_port_forwards(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    let pfs = state.port_forwards.lock().unwrap();
    let list = pfs.values().map(|s| {
        serde_json::json!({
            "id": s.id,
            "pod_name": s.pod_name,
            "namespace": s.namespace,
            "local_port": s.local_port,
            "pod_port": s.pod_port,
        })
    }).collect();
    Ok(list)
}
