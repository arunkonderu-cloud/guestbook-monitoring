# Guestbook Monitoring

Extends the Pulumi Kubernetes Guestbook example with Prometheus and Grafana monitoring, deployed via Pulumi.

## Architecture

- Redis Leader (x1) + redis_exporter sidecar on :9121
- Redis Replica (x2) + redis_exporter sidecar on :9121
- Frontend (x3) + nginx-prometheus-exporter sidecar on :9113
- Prometheus (Helm) — scrapes all pods via prometheus.io annotations
- Grafana (Helm) — pre-configured with Prometheus datasource and Guestbook dashboard

## Prerequisites

- Pulumi CLI >= 3.x
- Node.js >= 18
- kubectl configured to your cluster
- Kubernetes cluster (EKS / GKE / AKS / minikube)

## Deploy

### 1. Install dependencies
npm install

### 2. Create a Pulumi stack
pulumi stack init dev

### 3. For minikube
pulumi config set isMinikube true

### 4. Deploy
pulumi up

## Grafana Access

Get the URL:
kubectl get svc grafana -n guestbook -o jsonpath='{.status.loadBalancer.ingress[0].ip}'

Credentials:
- Username: admin
- Password: pulumi stack output grafanaAdminPasswordValue --show-secrets

## Verify Prometheus is Scraping

Port-forward Prometheus:
kubectl port-forward svc/prometheus-server 9090:80 -n guestbook

Open http://localhost:9090/targets — you should see guestbook-pods job with frontend and redis targets all UP.

Test a query:
rate(nginx_http_requests_total{kubernetes_namespace="guestbook"}[2m])
rate(redis_commands_processed_total{kubernetes_namespace="guestbook"}[2m])

## Teardown
pulumi destroy
pulumi stack rm dev
