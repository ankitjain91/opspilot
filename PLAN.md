# ArgoCD App Management Features - Implementation Plan

## Overview
Add the ability for users to:
1. Edit Helm values and apply changes to ArgoCD apps
2. Change the Helm chart version deployed
3. Trigger app sync with options (prune, force, dry-run)

## Current State
- ArgoCD apps are fetched via Kubernetes API (`list_resources` command)
- Apps display in a grid/list with health/sync status
- Detail modal shows resource tree, list view, and history
- **No edit/sync capabilities exist** - only viewing

## Implementation Plan

---

### Phase 1: Backend Commands (Rust)

#### 1.1 Create new file: `src-tauri/src/commands/argocd.rs`

**New Commands:**

```rust
// Patch Helm values on an ArgoCD Application
#[tauri::command]
pub async fn argo_patch_helm_values(
    namespace: String,
    name: String,
    values: String,  // YAML string
) -> Result<String, String>

// Patch chart version (targetRevision)
#[tauri::command]
pub async fn argo_patch_chart_version(
    namespace: String,
    name: String,
    target_revision: String,
    chart: Option<String>,  // Optional: change chart name too
) -> Result<String, String>

// Sync an ArgoCD application
#[tauri::command]
pub async fn argo_sync_application(
    namespace: String,
    name: String,
    prune: bool,
    force: bool,
    dry_run: bool,
) -> Result<String, String>

// Refresh app (soft refresh, re-fetch from git)
#[tauri::command]
pub async fn argo_refresh_application(
    namespace: String,
    name: String,
    hard: bool,  // Hard refresh invalidates cache
) -> Result<String, String>
```

**Implementation Approach:**
- Use Kubernetes API patches (JSON merge patch) for values/version changes
- For sync: Use annotation-based trigger (`argocd.argoproj.io/refresh` annotation)
- Sync with options requires ArgoCD CLI - detect if available, fallback gracefully

#### 1.2 Register commands in `lib.rs`

Add new module and register all commands in the invoke handler.

---

### Phase 2: Frontend - ArgoAppDetailsModal Enhancements

#### 2.1 Add new tabs to the modal

Current tabs: `tree`, `list`, `history`

New tabs to add:
- **`values`** - Helm values editor
- **`settings`** - Chart version, source settings

#### 2.2 Helm Values Tab (`values`)

**UI Components:**
- Monaco editor with YAML syntax highlighting
- "Current Values" section (read-only display of computed values)
- "Override Values" section (editable)
- "Apply Changes" button
- Diff view toggle to see changes

**Data Flow:**
```
spec.source.helm.values (YAML string) → Monaco Editor → Patch API
```

#### 2.3 Settings Tab (`settings`)

**UI Components:**
- **Source Section:**
  - Repository URL (display, link to repo)
  - Chart name (editable if Helm chart)
  - Target Revision / Version (editable input)
  - Path (for git-based apps)
- **Update Button** to apply changes

**Layout:**
```
┌─────────────────────────────────────────────────┐
│ Source Configuration                            │
├─────────────────────────────────────────────────┤
│ Repository:  https://charts.example.com   [🔗]  │
│ Chart:       nginx-ingress                      │
│ Version:     [4.9.1        ▾] ← dropdown/input  │
│ Path:        ./charts/myapp                     │
├─────────────────────────────────────────────────┤
│                              [Apply Changes]    │
└─────────────────────────────────────────────────┘
```

---

### Phase 3: Sync Dialog

#### 3.1 Add Sync button to modal header/footer

Location: Modal footer, next to "Close" button

#### 3.2 SyncDialog Component

**UI:**
```
┌─────────────────────────────────────────────────┐
│ Sync Application: my-app                        │
├─────────────────────────────────────────────────┤
│ Options:                                        │
│ ☐ Prune - Delete resources not in git          │
│ ☐ Force - Ignore cache, re-apply all           │
│ ☐ Dry Run - Preview changes without applying   │
├─────────────────────────────────────────────────┤
│ Sync Status: [Idle / Syncing... / Complete]    │
├─────────────────────────────────────────────────┤
│                    [Cancel]  [Sync]             │
└─────────────────────────────────────────────────┘
```

**Behavior:**
1. User clicks "Sync" in modal
2. Dialog opens with options
3. User selects options, clicks Sync
4. Backend triggers sync
5. Dialog shows progress/result
6. On success, modal refreshes app data

---

### Phase 4: Quick Actions in App Cards

#### 4.1 Add action buttons to ArgoApplications.tsx cards

**Card Actions:**
- 🔄 **Sync** - Quick sync (no options dialog)
- ⟳ **Refresh** - Soft refresh from git
- ⚙️ **Settings** - Opens modal to settings tab

---

## File Changes Summary

### New Files:
- `src-tauri/src/commands/argocd.rs` - Backend ArgoCD commands

### Modified Files:
- `src-tauri/src/lib.rs` - Register new commands
- `src/components/tools/ArgoAppDetailsModal.tsx` - Add tabs, sync button
- `src/components/tools/ArgoApplications.tsx` - Add card quick actions

---

## Implementation Order

1. **Backend first** - Create `argocd.rs` with all commands
2. **Settings tab** - Chart version change (simpler UI)
3. **Values tab** - Helm values editor
4. **Sync dialog** - Sync with options
5. **Quick actions** - Card-level buttons

---

## Technical Notes

### Patching ArgoCD Applications

ArgoCD Applications are standard Kubernetes CRDs. We patch them like any other resource:

```rust
// For Helm values
let patch = json!({
    "spec": {
        "source": {
            "helm": {
                "values": yaml_string
            }
        }
    }
});

// For chart version
let patch = json!({
    "spec": {
        "source": {
            "targetRevision": "4.9.1"
        }
    }
});
```

### Triggering Sync

**Method 1: Annotation-based (no CLI needed)**
```rust
let patch = json!({
    "metadata": {
        "annotations": {
            "argocd.argoproj.io/refresh": "hard"  // or "normal"
        }
    }
});
```
This triggers ArgoCD controller to refresh and sync.

**Method 2: ArgoCD CLI (more control)**
```bash
argocd app sync my-app --prune --force
```
Requires ArgoCD CLI installed and authenticated.

### Multi-Source Apps

Some ArgoCD apps use `spec.sources[]` instead of `spec.source`. Need to handle both:
- Check if `spec.sources` exists and is array
- If so, patch `sources[0]` or allow user to select source

---

## UI/UX Considerations

1. **Non-destructive defaults** - Prune and Force off by default
2. **Confirmation for dangerous ops** - Prune requires confirmation
3. **Real-time feedback** - Show sync progress
4. **Error handling** - Clear error messages for failures
5. **Optimistic updates** - Update UI immediately, rollback on error
