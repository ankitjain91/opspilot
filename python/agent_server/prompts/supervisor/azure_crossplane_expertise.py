"""
Domain Expertise: Azure & Crossplane Resources

This module provides expert knowledge about Azure cloud resources managed via Crossplane.
"""

AZURE_CROSSPLANE_EXPERTISE = """
═══════════════════════════════════════════════════════════════════════════════
🎓 AZURE & CROSSPLANE DOMAIN EXPERTISE
═══════════════════════════════════════════════════════════════════════════════

## CROSSPLANE BASICS

**What is Crossplane?**
- Infrastructure-as-Code platform for Kubernetes
- Manages cloud resources (Azure, AWS, GCP) as Kubernetes CRDs
- Uses "Providers" (e.g. provider-azure) to interact with cloud APIs

**Key Concepts**:
1. **Provider**: Plugin that adds cloud-specific CRDs (e.g. `provider-azure-*`)
2. **ManagedResource**: Actual cloud resource (VM, Storage, Database)
3. **Composite Resource (XR)**: Higher-level abstraction (e.g. "Database")
4. **Claim**: User-facing request for a composite resource

---

## FINDING AZURE RESOURCES - EXPERT APPROACH

**Query**: "Find all Azure resources"

**❌ WRONG APPROACH** (What the agent did):
```bash
kubectl get managed -A -o json | jq '.items[] | select(.kind | test("Azure"; "i"))'
```
**Problem**: Assumes 'managed' is a resource type, and filters by kind name containing "Azure"

**✅ CORRECT APPROACH** (What an expert does):

### Step 1: Check if Crossplane is installed
```bash
kubectl get providers
# OR
kubectl get provider.pkg.crossplane.io
```
**Expected Output**: List of installed providers (e.g. `provider-azure-*`, `provider-aws-*`)

**If empty**: Crossplane is NOT installed → Answer: "No Azure resources found (Crossplane not installed)"

### Step 2: Check for Azure provider specifically
```bash
kubectl get providers | grep -i azure
# OR
kubectl api-resources | grep azure
```
**Expected Output**: Azure provider names or Azure-related CRDs

**If empty**: Azure provider NOT installed → Answer: "No Azure resources found (Azure provider not installed)"

### Step 3: List ALL Azure CRDs
```bash
kubectl get crd | grep -E 'azure|upbound'
```
**Common Azure CRDs** (from provider-azure-upbound):
- `resourcegroups.azure.upbound.io`
- `virtualmachines.compute.azure.upbound.io`
- `managedclusters.containerservice.azure.upbound.io` (AKS clusters)
- `accounts.storage.azure.upbound.io` (Storage accounts)
- `virtualnetworks.network.azure.upbound.io` (VNets)
- `subnets.network.azure.upbound.io`
- `databases.dbformysql.azure.upbound.io` (MySQL databases)
- `databases.dbforpostgresql.azure.upbound.io` (PostgreSQL databases)

### Step 4: Get resources from EACH Azure CRD type
```bash
# Resource Groups
kubectl get resourcegroups.azure.upbound.io -A

# Virtual Machines
kubectl get virtualmachines.compute.azure.upbound.io -A

# AKS Clusters
kubectl get managedclusters.containerservice.azure.upbound.io -A

# Storage Accounts
kubectl get accounts.storage.azure.upbound.io -A

# Virtual Networks
kubectl get virtualnetworks.network.azure.upbound.io -A
```

### Step 5: Alternative - Get ALL managed resources and filter
```bash
# Get all managed resources (Crossplane term for cloud resources)
kubectl get managed -A

# Filter by Azure provider reference
kubectl get managed -A -o json | jq '.items[] | select(.spec.providerConfigRef.name | contains("azure"))'
```

### Step 6: Check node provider IDs (if looking for infrastructure)
```bash
kubectl get nodes -o json | jq '.items[].spec.providerID'
```
**Example Output**: `azure:///subscriptions/abc-123/...`

---

## COMMON CROSSPLANE RESOURCE TYPES

### Azure Provider (provider-azure-upbound.io)
- **Compute**: VirtualMachines, VMScaleSets, Disks, Images
- **Storage**: StorageAccounts, Containers, Blobs, FileShares
- **Network**: VirtualNetworks, Subnets, NetworkInterfaces, PublicIPs, LoadBalancers
- **Database**: SQL Servers/Databases, MySQL, PostgreSQL, CosmosDB
- **Container**: AKS (ManagedClusters), Container Instances, Container Registries
- **Identity**: ManagedIdentities, ServicePrincipals
- **KeyVault**: Vaults, Secrets, Keys

### AWS Provider (provider-aws-upbound.io)
- **Compute**: EC2 Instances, Auto Scaling Groups, Lambda Functions
- **Storage**: S3 Buckets, EBS Volumes, EFS
- **Network**: VPCs, Subnets, Security Groups, Route Tables, LoadBalancers
- **Database**: RDS, DynamoDB, ElastiCache, Redshift
- **Container**: EKS Clusters, ECS Services, ECR Repositories

### GCP Provider (provider-gcp-upbound.io)
- **Compute**: Compute Instances, Instance Groups, Cloud Functions
- **Storage**: Cloud Storage Buckets, Persistent Disks
- **Network**: VPCs, Subnets, Firewalls, Cloud Load Balancers
- **Database**: Cloud SQL, Firestore, Bigtable, Spanner
- **Container**: GKE Clusters, Cloud Run Services, Container Registry

---

## TROUBLESHOOTING PATTERNS

### Pattern 1: "Resource not found" when querying Azure resources

**Diagnosis Steps**:
1. ✅ Check Crossplane installed: `kubectl get providers`
2. ✅ Check Azure provider installed: `kubectl get providers | grep azure`
3. ✅ Check CRDs available: `kubectl api-resources | grep azure`
4. ✅ Check managed resources exist: `kubectl get managed -A`

**Common Root Causes**:
- Crossplane not installed
- Azure provider not installed/configured
- No resources provisioned yet
- Wrong cluster context
- Insufficient RBAC permissions

### Pattern 2: Managed resource stuck in "Creating" state

**Diagnosis Steps**:
1. Check resource status: `kubectl get <resource-type> <name> -o yaml | grep -A 20 status`
2. Check conditions: `kubectl get <resource-type> <name> -o json | jq '.status.conditions'`
3. Check provider logs: `kubectl logs -n crossplane-system deploy/provider-azure-*`
4. Check providerConfig: `kubectl get providerconfig -A`

**Common Root Causes**:
- Invalid Azure credentials in ProviderConfig
- Missing Azure permissions (Contributor role needed)
- Invalid resource configuration (e.g. invalid SKU, region)
- Azure quota limits exceeded
- Network connectivity issues to Azure API

### Pattern 3: Finding resources by cloud provider

**Query**: "What cloud resources are running?"

**Expert Approach**:
```bash
# Check what providers are installed
kubectl get providers

# Get all managed resources (across ALL providers)
kubectl get managed -A

# Group by provider
kubectl get managed -A -o json | jq -r '.items[] | "\\(.spec.providerConfigRef.name) - \\(.kind)"' | sort | uniq -c
```

---

## DECISION TREE: "Find Azure Resources"

```
User Query: "Find all Azure resources"
    |
    ├─> Check: Is Crossplane installed?
    |       ├─> NO → Answer: "Crossplane not installed, no cloud resources managed"
    |       └─> YES → Continue
    |
    ├─> Check: Is Azure provider installed?
    |       ├─> NO → Answer: "Azure provider not installed, no Azure resources"
    |       └─> YES → Continue
    |
    ├─> Get list of Azure CRDs
    |       └─> `kubectl get crd | grep azure`
    |
    ├─> For EACH Azure CRD, query resources
    |       └─> `kubectl get <crd-name> -A`
    |
    ├─> Aggregate results
    |       ├─> FOUND resources → List them grouped by type
    |       └─> NO resources → Answer: "No Azure resources provisioned (provider installed but no resources created)"
    |
    └─> Format response with:
            - Total count by resource type
            - Resource names and namespaces
            - Status summary (Ready/NotReady)
```

---

## EXAMPLE RESPONSES

### Example 1: Azure Provider Installed, Resources Found
```markdown
**Azure Resources in Cluster:**

- **Resource Groups** (2): `rg-production`, `rg-staging`
- **Storage Accounts** (3): `storprod001`, `storstg001`, `stordev001`
- **AKS Clusters** (1): `aks-production-eastus`
- **Virtual Networks** (2): `vnet-prod`, `vnet-staging`

**Total**: 8 Azure resources managed by Crossplane

💡 **Tip**: Use `kubectl describe <resource-type> <name>` for detailed status
```

### Example 2: Crossplane Not Installed
```markdown
**No Azure resources found** - Crossplane is not installed in this cluster.

**Crossplane** is an infrastructure-as-code platform for Kubernetes that manages cloud resources (Azure, AWS, GCP) as Kubernetes Custom Resources.

💡 **To install Crossplane**:
```bash
helm repo add crossplane-stable https://charts.crossplane.io/stable
helm install crossplane crossplane-stable/crossplane --namespace crossplane-system --create-namespace
```
```

### Example 3: Provider Installed, No Resources
```markdown
**No Azure resources found** (yet).

**Status**:
- ✅ Crossplane is installed
- ✅ Azure provider is installed and configured
- ❌ No Azure resources have been provisioned

💡 **To create an Azure resource**, apply a manifest like:
```yaml
apiVersion: azure.upbound.io/v1beta1
kind: ResourceGroup
metadata:
  name: my-resource-group
spec:
  forProvider:
    location: East US
```
```

---

## COMMAND TEMPLATES

### Discovery Commands
```bash
# List all Crossplane providers
kubectl get providers

# List all managed resources (all clouds)
kubectl get managed -A

# List Azure-specific resources
kubectl get resourcegroups.azure.upbound.io -A
kubectl get accounts.storage.azure.upbound.io -A
kubectl get managedclusters.containerservice.azure.upbound.io -A

# Check resource status
kubectl get <resource-type> <name> -o yaml

# Check provider logs
kubectl logs -n crossplane-system -l pkg.crossplane.io/provider=provider-azure
```

### Troubleshooting Commands
```bash
# Check provider configuration
kubectl get providerconfig -A

# Check Azure credentials secret
kubectl get secret -n crossplane-system

# Describe resource for events
kubectl describe <resource-type> <name>

# Check CRD definitions
kubectl get crd | grep azure
kubectl explain <resource-type>
```

---

## WHEN TO USE THIS EXPERTISE

**Apply this knowledge when**:
- User asks about "Azure", "cloud resources", "Crossplane", "managed resources"
- Query includes provider names (azure, aws, gcp, upbound)
- Looking for infrastructure resources (VMs, storage, databases, networks)
- Debugging provisioning failures
- Need to understand what cloud resources exist in cluster

**DON'T overthink** - If user asks simple question like "list pods", don't apply cloud expertise!
"""
