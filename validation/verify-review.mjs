import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync, mkdirSync, readdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Local-only verification: no kubectl, SSH, repository mutation, or network access.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const candidate = resolve(root, '../../rca-deployment-2026-10-18/gitops-candidate');
const helm = process.argv[2] || resolve(candidate, '../.tools/windows-amd64/helm.exe');
const parser = resolve(root, 'validation/yaml-parser');
const output = resolve(root, 'validation/rendered');
mkdirSync(output, {recursive: true});
const text = path => readFileSync(path, 'utf8');
const run = args => execFileSync(helm, args, {encoding:'utf8', maxBuffer:20*1024*1024});
const canonical = object => JSON.stringify(sort(object));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,sort(value[key])]));
  return value;
}
function yamlFile(path) {
  const rendered = run(['template','parser',parser,'--set-file',`payload=${path.replaceAll('\\','/')}`]);
  const marker = '  docs.json: |-\n';
  assert(rendered.includes(marker), 'YAML parser result missing');
  const docs = JSON.parse(rendered.slice(rendered.indexOf(marker)+marker.length).trim());
  for (const doc of docs) assert(!doc.Error, `YAML parse failed: ${doc.Error}`);
  return docs;
}
function yamlText(content, name) {
  const path = resolve(output, `${name}.yaml`);
  writeFileSync(path, content);
  return yamlFile(path);
}
function render(release, chart, values, name) {
  const args = ['template',release,chart,'--namespace','rca-system','--kube-version','1.36.5'];
  for (const path of values) args.push('-f',path);
  const rendered = run(args);
  return yamlText(rendered,name);
}
const currentPlatformChart=resolve(candidate,'charts/cluster-infra-rca-platform');
const currentAgentChart=resolve(candidate,'charts/cluster-infra-rca-agent');
const platformChart=resolve(root,'applications/onprem/platform/chart');
const agentChart=resolve(root,'applications/onprem/agent/chart');
const platformValues=resolve(root,'environments/onprem/platform/values.yaml');
const agentValues=resolve(root,'environments/onprem/agent/values.yaml');
function files(base, prefix='') {
  return readdirSync(resolve(base,prefix),{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(base,`${prefix}${entry.name}/`):[`${prefix}${entry.name}`]).sort();
}
const vendoredChartChanges=[];
for (const [label,oldChart,newChart] of [['platform',currentPlatformChart,platformChart],['agent',currentAgentChart,agentChart]]) {
  assert.deepEqual(files(oldChart),files(newChart));
  for (const file of files(oldChart)) {
    const oldBytes=readFileSync(resolve(oldChart,file)),newBytes=readFileSync(resolve(newChart,file));
    if (!oldBytes.equals(newBytes)) vendoredChartChanges.push(`${label}/${file}`);
  }
}
assert.deepEqual(vendoredChartChanges,['platform/templates/platform-agent-enrollment-preflight-job.yaml']);
assert.equal(text(platformValues),text(resolve(candidate,'values-onprem.deployment.yaml')));
assert.equal(text(agentValues),text(resolve(candidate,'values-agent-canary.deployment.yaml')));
const baselinePlatform=render('rca',currentPlatformChart,[resolve(currentPlatformChart,'values-production.yaml'),resolve(candidate,'values-onprem.deployment.yaml')],'candidate-platform');
const proposedPlatform=render('rca',platformChart,[resolve(platformChart,'values-production.yaml'),platformValues],'proposed-platform');
const baselineAgent=render('rca-agent-canary',currentAgentChart,[resolve(candidate,'values-agent-canary.deployment.yaml')],'candidate-agent');
const proposedAgent=render('rca-agent-canary',agentChart,[agentValues],'proposed-agent');
assert.equal(proposedPlatform.length,9);
assert.equal(proposedAgent.length,3);
const hook=proposedPlatform.find(doc=>doc.kind==='Job');
assert.equal(hook.metadata.name,'rca-agent-enrollment-preflight');
assert.equal(hook.metadata.annotations['argocd.argoproj.io/hook'],'Skip');
assert.equal(hook.metadata.annotations['helm.sh/hook'],'pre-upgrade');
const adjusted=structuredClone(proposedPlatform);
delete adjusted.find(doc=>doc.kind==='Job').metadata.annotations['argocd.argoproj.io/hook'];
assert.equal(canonical(adjusted),canonical(baselinePlatform),'Platform differs beyond the approved hook Skip annotation');
assert.equal(canonical(proposedAgent),canonical(baselineAgent),'Agent desired state changed');
for (const doc of [...proposedPlatform,...proposedAgent]) {
  assert(!['Secret','PersistentVolumeClaim','PersistentVolume','StatefulSet','Namespace','Role','RoleBinding','ClusterRole','ClusterRoleBinding','CustomResourceDefinition'].includes(doc.kind),`Excluded resource rendered: ${doc.kind}`);
}
const platformDeployment=proposedPlatform.find(doc=>doc.kind==='Deployment');
assert.equal(platformDeployment.spec.replicas,2);
assert.equal(platformDeployment.spec.template.metadata.labels['app.kubernetes.io/instance'],'rca');
const daemonSet=proposedAgent.find(doc=>doc.kind==='DaemonSet');
assert.equal(daemonSet.spec.template.spec.nodeSelector['kubernetes.io/hostname'],'k8s-worker-02');
assert.equal(daemonSet.spec.template.metadata.labels['app.kubernetes.io/instance'],'rca-agent-canary');
const repo='https://github.com/nembutal-sw/rca-platform-gitops.git';
const bootstrap=[
  ['stage-1-test/application.yaml','stage-1-test/project.yaml', 'rca-gitops-test'],
  ['stage-2-production-review/platform-application.yaml','stage-2-production-review/platform-project.yaml','rca-system'],
  ['stage-2-production-review/agent-application.yaml','stage-2-production-review/agent-project.yaml','rca-system'],
];
const inventories=[];
for (const [appPath,projectPath,namespace] of bootstrap) {
  const [app]=yamlFile(resolve(root,'bootstrap',appPath));
  const [project]=yamlFile(resolve(root,'bootstrap',projectPath));
  assert.equal(app.kind,'Application');
  assert.equal(app.metadata.namespace,'argocd');
  assert(!app.metadata.finalizers?.length);
  assert.equal(app.spec.project,project.metadata.name);
  assert.equal(app.spec.source.repoURL,repo);
  assert.equal(app.spec.source.targetRevision,'REPLACE_WITH_REVIEWED_GIT_COMMIT_SHA');
  assert.equal(app.spec.destination.namespace,namespace);
  assert.equal(app.spec.destination.server,'https://kubernetes.default.svc');
  assert(!Object.hasOwn(app.spec.syncPolicy,'automated'));
  assert.equal(canonical(app.spec.syncPolicy.syncOptions),canonical(['Prune=false','Delete=false','FailOnSharedResource=true','Replace=false','ServerSideApply=false']));
  assert(!app.spec.ignoreDifferences);
  assert(!app.spec.syncPolicy.managedNamespaceMetadata);
  assert.deepEqual(project.spec.sourceRepos,[repo]);
  assert.deepEqual(project.spec.destinations,[{server:'https://kubernetes.default.svc',namespace}]);
  assert.deepEqual(project.spec.clusterResourceWhitelist,[]);
  for (const allowed of project.spec.namespaceResourceWhitelist) {
    // In v3.5.5, namespace whitelist items contain group/kind only. Name is
    // supported for cluster-scoped restrictions, not this namespaced list.
    assert(!Object.hasOwn(allowed,'name'));
    assert(!allowed.group.includes('*') && !allowed.kind.includes('*'));
    assert(!['Secret','PersistentVolumeClaim','StatefulSet','Job','Role','RoleBinding'].includes(allowed.kind));
  }
  if (app.spec.source.helm) {
    const expected=app.metadata.name==='rca-platform-onprem'?'rca':'rca-agent-canary';
    assert.equal(app.spec.source.helm.releaseName,expected);
    for (const file of app.spec.source.helm.valueFiles) {
      const resolvedFile=resolve(root,app.spec.source.path,file);
      assert(resolvedFile.startsWith(root),'Values file escapes repository root');
      assert(readFileSync(resolvedFile).length>0);
    }
    const docs=expected==='rca'?proposedPlatform.filter(doc=>doc!==hook):proposedAgent;
    for (const doc of docs) {
      const group=doc.apiVersion.includes('/')?doc.apiVersion.split('/')[0]:'';
      assert(project.spec.namespaceResourceWhitelist.some(rule=>rule.group===group && rule.kind===doc.kind),`No AppProject kind rule for ${doc.kind}/${doc.metadata.name}`);
    }
    assert.equal(project.spec.namespaceResourceWhitelist.length,docs.length);
  }
  inventories.push({application:app.metadata.name,namespace,project:project.metadata.name,allowedKinds:project.spec.namespaceResourceWhitelist});
}
const [testDeployment]=yamlFile(resolve(root,'applications/onprem/gitops-test/deployment.yaml'));
const [testConfigMap]=yamlFile(resolve(root,'applications/onprem/gitops-test/configmap.yaml'));
assert.equal(testDeployment.metadata.name,'rca-gitops-proof');
assert.equal(testConfigMap.metadata.name,'rca-gitops-proof');
assert.equal(testDeployment.metadata.namespace,'rca-gitops-test');
assert.equal(testConfigMap.metadata.namespace,'rca-gitops-test');
const pod=testDeployment.spec.template.spec, container=pod.containers[0];
assert.equal(pod.automountServiceAccountToken,false);
assert.equal(pod.securityContext.runAsNonRoot,true);
assert.equal(pod.securityContext.seccompProfile.type,'RuntimeDefault');
assert(!pod.hostPID && !pod.hostNetwork && !pod.hostIPC);
assert(pod.volumes.every(volume=>volume.configMap && !volume.hostPath && !volume.persistentVolumeClaim && !volume.secret));
assert.equal(container.securityContext.allowPrivilegeEscalation,false);
assert.equal(container.securityContext.readOnlyRootFilesystem,true);
assert.deepEqual(container.securityContext.capabilities.drop,['ALL']);
assert.equal(container.image,podImage(baselineAgent));
assert.equal(container.imagePullPolicy,'Never');
assert(!pod.imagePullSecrets);
assert.equal(pod.nodeSelector['kubernetes.io/hostname'],'k8s-worker-02');
assert.equal(container.volumeMounts[0].readOnly,true);
function podImage(docs) { return docs.find(doc=>doc.kind==='DaemonSet').spec.template.spec.containers[0].image; }
for (const [chart,values] of [[platformChart,[resolve(platformChart,'values-production.yaml'),platformValues]],[agentChart,[agentValues]]]) {
  const args=['lint',chart,'--kube-version','1.36.5'];
  for (const value of values) args.push('-f',value);
  run(args);
}
const report={
  reviewOnly:true,localValidationPassed:true,clusterAccessPerformed:false,
  helm:run(['version','--short']).trim(),kubeVersion:'1.36.5',
  platformResources:proposedPlatform.map(doc=>`${doc.kind}/${doc.metadata.name}`),
  agentResources:proposedAgent.map(doc=>`${doc.kind}/${doc.metadata.name}`),
  changedRenderedFields:['Job/rca-agent-enrollment-preflight metadata.annotations.argocd.argoproj.io/hook = Skip'],
  platformAllOtherFieldsEqualToSavedCandidate:true,agentAllFieldsEqualToSavedCandidate:true,
  deploymentAndDaemonSetSpecsEqualToSavedCandidate:true,
  vendoredChartChanges,
  dbPvcSecretOrClusterScopedResourcesRendered:false,applications:inventories,
  unresolved:['Private repository push and Git commit pinning are managed by the root task; not performed by this review script','Replace each reviewed Git commit placeholder before registration','Verify current image cache on worker-02 before isolated test','Argo CD Helm 4 rendering, API admission, Project and namespace RBAC validation, and live workload comparison are pending','No actual adoption or sync performed by this review task'],
};
writeFileSync(resolve(root,'validation/local-validation.json'),JSON.stringify(report,null,2)+'\n');
const sourceProvenance={
  upstream:'https://github.com/nembutal-sw/kubernetes-cluster-infra-rca-platform',
  auditedCommit:'af730cd657581dde532526be04b6478555351c52',
  candidate:'rca-deployment-2026-10-18/gitops-candidate',
  changedVendoredFiles:vendoredChartChanges,
  values:[platformValues,agentValues].map(path=>({path:path.slice(root.length+1).replaceAll('\\','/'),sha256:createHash('sha256').update(readFileSync(path)).digest('hex')})),
  pythonImageProvenanceSource:'rca-deployment-2026-10-18/agent-image-provenance.json',
  pythonImageRuntimeSource:'rca-deployment-2026-10-18/agent-runtime-validation.json',
  imageDigest:'sha256:dde674dda41eb656757d7507c68c1f78c4184e893654f42f750858919557625c',
  currentInfrastructureValidated:false,
};
writeFileSync(resolve(root,'review/source-provenance.json'),JSON.stringify(sourceProvenance,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
