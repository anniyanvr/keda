import * as async from 'async';
import * as fs from 'fs';
import * as sh from 'shelljs';
import * as tmp from 'tmp';
import * as redis from 'redis';
import test from 'ava';

const requirements = {
    env: [],
    tools: ['helm', 'kubectl']
}

const redisNamespace = 'redis-keda-test'
const redisListName = 'testlist'

test.before.cb('setup redis and the deployment', t => {
    if (requirements.env.find(e => !process.env[e]) ||
        requirements.tools.find(t => !sh.which(t))) {
        t.fail(`${JSON.stringify(requirements)} one or more requirement is missing`)
    }

    if (sh.exec('kubectl -n kube-system get serviceaccount tiller').code === 1) {
        // create the user if it doesn't exist
        sh.exec('kubectl -n kube-system create serviceaccount tiller')
        sh.exec('kubectl create clusterrolebinding tiller --clusterrole=cluster-admin --serviceaccount=kube-system:tiller')
    }
    sh.exec('helm init --wait --service-account tiller')
    sh.exec('helm install --name redis --namespace redis-ns --set usePassword=false --wait stable/redis')
    sh.exec(`kubectl create namespace ${redisNamespace}`)

    const deploy = sh.exec('kubectl apply -f -', { async: true })
    deploy.stdin.end(deploymentYaml)
    deploy.on('exit', code => {
        t.is(0, code)
        t.end()
    })
})

test.serial('Deployment should have 0 replicas on start', t => {
    const replicaCount = sh.exec(`kubectl get deployment.apps/redis-test-deployment --namespace ${redisNamespace} -o jsonpath="{.spec.replicas}"`).stdout;
    t.is(replicaCount, '0', 'replica count should start out as 0');
});

test.serial.cb.only('Deployment should scale to 4 with 1,000 items on the list', t => {
    const portForward = sh.exec('kubectl port-forward svc/redis-keda-test-release-master 6379:6379', { async: true })
    sh.exec('sleep 4s')
    const client = redis.createClient(6379, 'localhost')
    client.on('ready', () => {
        client.lpush('workItems', Array.from(Array(100).keys()).map(i => i + ''), () => {
            let replicaCount = '0';
            for (let i = 0; i < 10 && replicaCount !== '4'; i++) {
                replicaCount = sh.exec(`kubectl get deployment.apps/redis-test-deployment --namespace ${redisNamespace} -o jsonpath="{.spec.replicas}"`).stdout;
                if (replicaCount !== '4') {
                    sh.exec('sleep 1s');
                }
            }

            t.is('4', replicaCount, 'Replica count should be 4 after 10 seconds');
            portForward.kill()
            t.end()
        })
    })
})

const deploymentYaml = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis-test-deployment
  namespace: ${redisNamespace}
  labels:
    app: redis-test-deployment
spec:
  replicas: 0
  selector:
    matchLabels:
      app: redis-test-deployment
  template:
    metadata:
      name:
      namespace:
      labels:
        app: redis-test-deployment
    spec:
      containers:
      - name: redis-test-deployment
        image: ahmelsayed/slow-redis-consumer:latest
        resources:
        ports:
        env:
        - name: REDIS_HOST
          value: redis-keda-test-release-master.default.svc.cluster.local
        - name: REDIS_LIST_NAME
          value: ${redisListName}
---
apiVersion: keda.k8s.io/v1alpha1
kind: ScaledObject
metadata:
  name: redis-test-scaledobject
  namespace: ${redisNamespace}
  labels:
    deploymentName: redis-test-deployment
spec:
  scaleTargetRef:
    deploymentName: redis-test-deployment
  pollingInterval: 5
  maxReplicaCount: 4
  cooldownPeriod: 10
  triggers:
  - type: redis
    metadata:
      address: redis-keda-test-release-master.default.svc.cluster.local
      listName: ${redisListName}
      listLength: "5" # Required
`;