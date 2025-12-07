
import { K8sObject } from './k8s';

export interface Tab {
    id: string;
    resource: K8sObject;
    kind: string;
}
