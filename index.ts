import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const cfg = new pulumi.Config();
const isMinikube = cfg.getBoolean("isMinikube") ?? false;
const namespace = cfg.get("namespace") ?? "guestbook";

const grafanaAdminPassword =
    cfg.getSecret("grafanaPassword") ??
    new random.RandomPassword("grafana-password", {
        length: 16,
        special: false,
    }).result;

// ---------------------------------------------------------------------------
// Namespace
// ---------------------------------------------------------------------------
const ns = new k8s.core.v1.Namespace("guestbook-ns", {
    metadata: { name: namespace },
});

const nsName = ns.metadata.name;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const svcType = (expose: boolean) =>
    expose ? (isMinikube ? "NodePort" : "LoadBalancer") : "ClusterIP";

// ---------------------------------------------------------------------------
// Redis Leader
// ---------------------------------------------------------------------------
const redisLeaderLabels = { app: "redis-leader" };

const redisLeaderDeployment = new k8s.apps.v1.Deployment("redis-leader", {
    metadata: { namespace: nsName, name: "redis-leader" },
    spec: {
        selector: { matchLabels: redisLeaderLabels },
        replicas: 1,
        template: {
            metadata: {
                labels: redisLeaderLabels,
                annotations: {
                    "prometheus.io/scrape": "true",
                    "prometheus.io/port": "9121",
                },
            },
            spec: {
                containers: [
                    {
                        name: "redis-leader",
                        image: "redis:7",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        ports: [{ containerPort: 6379, name: "redis" }],
                    },
                    {
                        // Redis exporter sidecar exposes /metrics on :9121
                        name: "redis-exporter",
                        image: "oliver006/redis_exporter:v1.62.0",
                        resources: { requests: { cpu: "50m", memory: "32Mi" } },
                        ports: [{ containerPort: 9121, name: "metrics" }],
                    },
                ],
            },
        },
    },
}, { dependsOn: ns });

const redisLeaderService = new k8s.core.v1.Service("redis-leader-svc", {
    metadata: { namespace: nsName, name: "redis-leader", labels: redisLeaderLabels },
    spec: {
        selector: redisLeaderLabels,
        ports: [{ port: 6379, targetPort: 6379, name: "redis" }],
    },
}, { dependsOn: redisLeaderDeployment });

// ---------------------------------------------------------------------------
// Redis Replica
// ---------------------------------------------------------------------------
const redisReplicaLabels = { app: "redis-replica" };

const redisReplicaDeployment = new k8s.apps.v1.Deployment("redis-replica", {
    metadata: { namespace: nsName, name: "redis-replica" },
    spec: {
        selector: { matchLabels: redisReplicaLabels },
        replicas: 2,
        template: {
            metadata: {
                labels: redisReplicaLabels,
                annotations: {
                    "prometheus.io/scrape": "true",
                    "prometheus.io/port": "9121",
                },
            },
            spec: {
                containers: [
                    {
                        name: "redis-replica",
                        image: "pulumi/guestbook-redis-replica",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                        ports: [{ containerPort: 6379, name: "redis" }],
                    },
                    {
                        name: "redis-exporter",
                        image: "oliver006/redis_exporter:v1.62.0",
                        resources: { requests: { cpu: "50m", memory: "32Mi" } },
                        ports: [{ containerPort: 9121, name: "metrics" }],
                    },
                ],
            },
        },
    },
}, { dependsOn: [ns, redisLeaderService] });

const redisReplicaService = new k8s.core.v1.Service("redis-replica-svc", {
    metadata: { namespace: nsName, name: "redis-replica", labels: redisReplicaLabels },
    spec: {
        selector: redisReplicaLabels,
        ports: [{ port: 6379, targetPort: 6379, name: "redis" }],
    },
}, { dependsOn: redisReplicaDeployment });

// ---------------------------------------------------------------------------
// Guestbook Frontend
// ---------------------------------------------------------------------------
const frontendLabels = { app: "frontend" };

const frontendDeployment = new k8s.apps.v1.Deployment("frontend", {
    metadata: { namespace: nsName, name: "frontend" },
    spec: {
        selector: { matchLabels: frontendLabels },
        replicas: 3,
        template: {
            metadata: {
                labels: frontendLabels,
                annotations: {
                    // nginx-prometheus-exporter sidecar exposes metrics on :9113
                    "prometheus.io/scrape": "true",
                    "prometheus.io/port": "9113",
                    "prometheus.io/path": "/metrics",
                },
            },
            spec: {
                containers: [
                    {
                        name: "php-redis",
                        image: "pulumi/guestbook-php-redis",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                        ports: [{ containerPort: 80, name: "http" }],
                    },
                    {
                        // nginx-prometheus-exporter scrapes nginx stub_status
                        name: "nginx-exporter",
                        image: "nginx/nginx-prometheus-exporter:1.3",
                        args: ["--nginx.scrape-uri=http://localhost/nginx_status"],
                        resources: { requests: { cpu: "50m", memory: "32Mi" } },
                        ports: [{ containerPort: 9113, name: "metrics" }],
                    },
                ],
            },
        },
    },
}, { dependsOn: [ns, redisLeaderService, redisReplicaService] });

const frontendService = new k8s.core.v1.Service("frontend-svc", {
    metadata: { namespace: nsName, name: "frontend", labels: frontendLabels },
    spec: {
        type: svcType(true),
        selector: frontendLabels,
        ports: [{ port: 80, targetPort: 80, name: "http" }],
    },
}, { dependsOn: frontendDeployment });

// ---------------------------------------------------------------------------
// Prometheus (Helm)
// ---------------------------------------------------------------------------
const prometheusRelease = new k8s.helm.v3.Release("prometheus", {
    name: "prometheus",
    namespace: nsName,
    chart: "prometheus",
    repositoryOpts: { repo: "https://prometheus-community.github.io/helm-charts" },
    version: "25.27.0",
    values: {
        server: {
            global: { scrape_interval: "15s" },
        },
        // Annotation-based pod scraping — picks up all pods with
        // prometheus.io/scrape=true in the guestbook namespace
        serverFiles: {
            "prometheus.yml": {
                scrape_configs: [
                    {
                        job_name: "prometheus",
                        static_configs: [{ targets: ["localhost:9090"] }],
                    },
                    {
                        job_name: "guestbook-pods",
                        kubernetes_sd_configs: [
                            {
                                role: "pod",
                                namespaces: { names: [namespace] },
                            },
                        ],
                        relabel_configs: [
                            {
                                source_labels: ["__meta_kubernetes_pod_annotation_prometheus_io_scrape"],
                                action: "keep",
                                regex: "true",
                            },
                            {
                                source_labels: ["__meta_kubernetes_pod_annotation_prometheus_io_path"],
                                action: "replace",
                                target_label: "__metrics_path__",
                                regex: "(.+)",
                            },
                            {
                                source_labels: [
                                    "__address__",
                                    "__meta_kubernetes_pod_annotation_prometheus_io_port",
                                ],
                                action: "replace",
                                regex: "([^:]+)(?::\\d+)?;(\\d+)",
                                replacement: "$1:$2",
                                target_label: "__address__",
                            },
                            {
                                action: "labelmap",
                                regex: "__meta_kubernetes_pod_label_(.+)",
                            },
                            {
                                source_labels: ["__meta_kubernetes_namespace"],
                                action: "replace",
                                target_label: "kubernetes_namespace",
                            },
                            {
                                source_labels: ["__meta_kubernetes_pod_name"],
                                action: "replace",
                                target_label: "kubernetes_pod_name",
                            },
                        ],
                    },
                ],
            },
        },
        alertmanager: { enabled: false },
        "prometheus-pushgateway": { enabled: false },
        rbac: { create: true },
        serviceAccounts: { server: { create: true } },
        service: { type: "ClusterIP" },
    },
}, { dependsOn: ns });

// ---------------------------------------------------------------------------
// Grafana dashboard ConfigMap (auto-provisioned via sidecar)
// ---------------------------------------------------------------------------
const dashboardCm = new k8s.core.v1.ConfigMap("grafana-dashboards-cm", {
    metadata: {
        namespace: nsName,
        name: "grafana-guestbook-dashboards",
        labels: { grafana_dashboard: "1" },
    },
    data: {
        "guestbook.json": fs.readFileSync("./grafana-dashboards/guestbook.json", "utf-8"),
    },
}, { dependsOn: ns });

// ---------------------------------------------------------------------------
// Grafana (Helm)
// ---------------------------------------------------------------------------
const grafanaRelease = new k8s.helm.v3.Release("grafana", {
    name: "grafana",
    namespace: nsName,
    chart: "grafana",
    repositoryOpts: { repo: "https://grafana.github.io/helm-charts" },
    version: "8.4.2",
    values: {
        adminPassword: grafanaAdminPassword,
        service: {
            type: svcType(true),
            port: 80,
        },
        datasources: {
            "datasources.yaml": {
                apiVersion: 1,
                datasources: [
                    {
                        name: "Prometheus",
                        type: "prometheus",
                        url: `http://prometheus-server.${namespace}.svc.cluster.local`,
                        access: "proxy",
                        isDefault: true,
                    },
                ],
            },
        },
        sidecar: {
            dashboards: {
                enabled: true,
                label: "grafana_dashboard",
                searchNamespace: namespace,
            },
        },
    },
}, { dependsOn: [ns, prometheusRelease, dashboardCm] });

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
export const frontendIp = frontendService.status.apply(s => {
    if (isMinikube) return `run: minikube service frontend -n ${namespace} --url`;
    const i = s?.loadBalancer?.ingress?.[0];
    return i?.ip ?? i?.hostname ?? "pending — retry after a minute";
});

export const grafanaExternalIp = grafanaRelease.status.apply(_s => {
    if (isMinikube) return `run: minikube service grafana -n ${namespace} --url`;
    return "pending — run: kubectl get svc grafana -n " + namespace + " -o jsonpath='{.status.loadBalancer.ingress[0].ip}'";
});

export const grafanaAdminUser = "admin";
export const grafanaAdminPasswordValue = pulumi.secret(grafanaAdminPassword);
export const prometheusInternalUrl = `http://prometheus-server.${namespace}.svc.cluster.local`;