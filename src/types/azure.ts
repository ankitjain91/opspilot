export interface AzureSubscription {
    id: string;
    name: string;
    state: string;
    isDefault: boolean;
    clusters: AksCluster[];
}

export interface AksCluster {
    id: string;
    name: string;
    resourceGroup: string;
    location: string;
    powerState: {
        code: string;
    };
}
