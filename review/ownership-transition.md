# 기존 Helm RCA 리소스의 Argo CD 채택 기록과 절차

2026-10-18~19 기준 운영 소유권 전환 기록이다. 기존 후보의 upstream 기준은 `af730cd657581dde532526be04b6478555351c52`다. Argo CD **v3.5.5 / Helm Chart 10.10.5**의 실제 설치·네 Pod Ready·TLS·관리자 초기 비밀번호 교체·read-only deploy key 연결을 확인했다. 시험 앱은 v2 자동 미적용→정확한 SHA 수동 Sync→동일 Pod UID/restart 0의 HTTP v2를 검증했다. **Platform만 승인 commit `8efe20a93373ecb65c82566331e7582f33d574ec`으로 metadata 채택 완료**했으며 8개 개별 Synced/전체 Synced·Healthy다. Agent 채택은 별도 미승인 상태다. 공개 설치·권한 사본은 `bootstrap/argocd`에 있다.

## 1. 관리 대상과 권한

| Application | source path | destination | Helm release | 수동 채택 대상 |
| --- | --- | --- | --- | --- |
| `rca-gitops-proof` | `applications/onprem/gitops-test` | `rca-gitops-test` | 해당 없음 | ConfigMap/Deployment `rca-gitops-proof` |
| `rca-platform-onprem` | `applications/onprem/platform/chart` | `rca-system` | `rca` | SA, Service, Deployment, Ingress, NetworkPolicy, PDB `rca-platform`; ServiceMonitor `rca`; AlertmanagerConfig `rca-webhook` |
| `rca-agent-canary-onprem` | `applications/onprem/agent/chart` | `rca-system` | `rca-agent-canary` | SA/DaemonSet `rca-agent-canary`; ConfigMap `rca-agent-canary-config` |

AppProject는 저장소를 `ssh://git@ssh.github.com:443/nembutal-sw/rca-platform-gitops.git` 하나로, 목적지를 명시한 클러스터/namespace 하나로 제한한다. clusterResourceWhitelist는 빈 목록이며 namespaceResourceWhitelist에는 표의 resource group/kind만 넣었다. `default` Project의 광범위 기본 권한을 RCA 앱에 사용하지 않는다. AppProject 정책과 Kubernetes Role은 별도 방어 계층이다. [공식 Projects 설명](https://argo-cd.readthedocs.io/en/stable/user-guide/projects/), [Project 명세](https://argo-cd.readthedocs.io/en/stable/operator-manual/project-specification/).

**이름은 검토 inventory이며 AppProject가 강제하는 이름 제한이 아니다.** v3.5.5 CRD에서 namespaceResourceWhitelist 항목은 `group`/`kind`만 지원하고 `name`은 cluster resource 제한에서만 지원한다. 따라서 허용된 kind의 다른 이름이 추가되면 Git 검토 및 등록 전 inventory 검사로 중단한다. Project나 Application을 임의 변경할 CI 권한을 부여하지 않는다. [v3.5.5 공식 AppProject CRD](https://raw.githubusercontent.com/argoproj/argo-cd/v3.5.5/manifests/crds/appproject-crd.yaml).

단계 1에서는 controller의 대상 namespace를 `rca-gitops-test` 하나로 제한한다. 테스트 성공과 운영 소유권 전환 검토 후에만 별도로 승인한 `rca-system` Role/Binding 및 cache 범위를 추가한다. 운영 Platform Role은 표의 기존 8개 정확한 resourceNames에 get/update/patch만 허용하며 create/delete는 없다. Agent 쓰기는 별도 승인용 Role로 분리한다. Secret/PVC/StatefulSet/Job/RBAC 쓰기를 허용하지 않는다. 이름 제한은 Role이 강제하지만 update/patch를 metadata 필드로 제한하지는 못하므로 정확한 revision의 실제 적용 diff 검토가 필수다. AppProject 제한을 controller의 넓은 ClusterRole 대신으로 간주하지 않는다.

다음 리소스는 GitOps 채택·추적·쓰기 대상에서 제외한다.

- PostgreSQL StatefulSet/Service/ConfigMap/SA/NetworkPolicy와 `rca-postgres-data` PVC.
- 런타임·Registry·TLS·DB·bootstrap Secret 및 Helm release Secret/history.
- PV, StorageClass, NFS export/권한/방화벽, Namespace, CRD, ClusterRole/Binding.
- 기존 관리자 Node reader 권한과 영구 `rca-agent-canary-infrastructure` PrometheusRule.

## 2. 수동 sync와 추적 방식

모든 Application은 `automated`와 finalizer를 생략했다. `CreateNamespace`, managedNamespaceMetadata, 광범위 ignoreDifferences도 없다. syncOptions는 `Prune=false`, `Delete=false`, `FailOnSharedResource=true`, `Replace=false`, `ServerSideApply=false`다. 3.5.5에서 앞 두 옵션은 Application 기본 정책으로 설정할 수 있다. 리소스에 별도 Prune/Delete 옵션을 추가하면 기본값을 덮어쓸 수 있으므로 해당 변경도 금지한다. [공식 자동 sync 정책](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/), [Sync 옵션](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-options/), [Application 삭제](https://argo-cd.readthedocs.io/en/stable/user-guide/app_deletion/).

Application의 `targetRevision`은 **main**이다. main의 변경을 수동 적용 전에 OutOfSync로 볼 수 있도록 유지한다. 자동 Sync는 없으며, **모든 수동 Sync와 dry-run은 검토한 정확한 40자리 commit SHA를 명시**한다. 승인 뒤 main이 이동해도 검토하지 않은 HEAD로 Sync하지 않는다. Application 필드를 영구 SHA로 고정하는 방식과 수동 작업 revision을 지정하는 방식을 혼동하지 않는다.

설치 시 `argocd-cm`의 `application.resourceTrackingMethod: annotation`을 명시적으로 확인한다. `annotation+label`이나 기본 instance label 추적을 사용하지 않는다. Helm release 이름을 명시했으므로 `app.kubernetes.io/instance=rca`와 `rca-agent-canary`를 그대로 유지한다. 이 값은 Deployment/DaemonSet selector, Service selector 및 Platform topology spread에 사용된다. 추적 방식이 annotation이면 Argo의 최상위 tracking-id annotation으로 소유 관계를 표시할 수 있다. [공식 Resource Tracking](https://argo-cd.readthedocs.io/en/stable/user-guide/resource_tracking/).

Argo CD는 Helm을 manifest 생성에 사용하며 Helm release 이력을 이어 쓰지 않는다. 기존 Helm labels/annotations와 release Secret을 제거하거나 Helm uninstall하지 않는다. 채택 후 Jenkins/운영자가 같은 릴리스에 `helm upgrade`를 실행하면 두 관리 주체가 충돌할 수 있다. CI는 빌드·검증·digest 변경 PR까지만 담당하고 운영 apply/upgrade는 중지한다. 비상 복귀 시에도 먼저 Argo 수동 sync 권한과 실행 중 작업을 통제하고 별도 검토한다. [공식 Helm 통합 설명](https://argo-cd.readthedocs.io/en/stable/user-guide/helm/).

현재 기존 `rca` Helm revision **4를 보존·동결**했다. metadata 채택으로 Helm revision을 새로 만들지 않았다. DB/PVC/Secret은 기존 관리 경로를 유지한다. 이 GitOps 저장소는 내부 주소 포함 공개 설정을 승인받아 public으로 전환했으며 main의 PR 필수·관리자 적용·force push/삭제 금지를 설정했다. 단독 소유자라 독립 승인자를 둘 수 없는 실제 제약에 따라 review count는 0이다. 독립 승인을 충족했다고 표현하지 않는다.

`FailOnSharedResource=true`는 다른 Argo Application의 추적을 감지한다. Helm 소유권이나 외부 Jenkins 실행을 탐지하는 장치라고 해석하지 않는다.

## 3. pre-upgrade Hook의 구체적 처리

기존 Chart는 `platform.agentEnrollmentPreflight.enabled=true`가 기본이며 `rca-agent-enrollment-preflight` Job에 Helm `pre-upgrade`, weight `-20`, delete policy `before-hook-creation,hook-succeeded`를 넣는다. Argo는 `pre-upgrade`를 PreSync로 해석하므로 초기 채택에서도 DB audit Job을 실행할 수 있다. 이번 변경은 이 Job의 **최상위 metadata annotation 하나**만 추가한다.

```diff
 annotations:
+  argocd.argoproj.io/hook: Skip
   helm.sh/hook: pre-upgrade
```

Job 생성·실행·삭제를 수행하지 않도록 Skip을 택했다. Job container spec, DB 참조, 배포 값 및 운영 Pod template은 수정하지 않았다. Skip은 audit 완료를 의미하지 않는다. Helm으로 직접 upgrade하면 기존 Helm Hook 의미가 남아 있으므로 이 사본을 직접 Helm upgrade하는 절차는 제공하지 않는다. [공식 Skip 의미](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/), [변경 diff](platform-hook-skip.diff).

v3.5.5 소스상 Skip은 sync phase를 반환하지 않으므로 sync task가 만들어지기 전에 제외된다. Project permission 검증은 만들어진 task에 수행된다. 다만 controller는 금지된 Job의 개별 상태를 Unknown으로 표시할 수 있다. 실제 등록 후 읽기 전용 비교와 승인된 dry-run에서 **Job task가 0개인지** 확인해야 하며, 상태 경고를 없애기 위해 Job 권한을 추가하지 않는다. 예상과 달리 차단되면 sync를 멈추고 `agentEnrollmentPreflight.enabled=false` 같은 대안을 별도 변경 diff로 검토한다. [정확한 버전 sync_phase.go](https://github.com/argoproj/argo-cd/blob/v3.5.5/gitops-engine/pkg/sync/sync_phase.go#L9), [sync task 생성/검증](https://github.com/argoproj/argo-cd/blob/v3.5.5/gitops-engine/pkg/sync/sync_context.go#L881), [controller 상태 처리](https://github.com/argoproj/argo-cd/blob/v3.5.5/controller/state.go#L895).

Argo의 Skip은 live lookup 생략을 뜻하지 않는다. v3.5.5 cache는 watch하지 않는 desired kind를 직접 GET할 수 있으므로 Job 읽기까지 전부 금지하면 비교 단계가 실패할 수 있다. 단계 2 검토 Role은 `batch/jobs`의 `get`만 `resourceNames: [rca-agent-enrollment-preflight]`로 제한한다. list/watch/create/update/patch/delete는 추가하지 않는다. Project에 desired Job GroupKind를 허용해야 해도 이 named GET 제한은 유지한다. 또는 Job을 렌더링하지 않는 `enabled=false` 변경안을 별도 검토한다. 실제 검증 전에는 Skip만으로 비교가 성공한다고 주장하지 않는다. Skip 승인 후 Argo Sync는 enrollment audit를 실행하지 않으므로, 향후 관련 변경에는 별도 승인된 수동 점검과 결과 기록이 필요하다. [v3.5.5 cache의 직접 GET](https://github.com/argoproj/argo-cd/blob/v3.5.5/gitops-engine/pkg/cache/cluster.go#L1472).

## 4. 검토 가능한 단계와 승인 조건

1. **로컬 준비:** Chart 사본, 공개 배포 값, Hook diff, lint/render 결과와 비밀값 검사를 확인한다. private 저장소에는 소스 경로만 올린다. Application은 main을 추적하되 첫 적용과 이후 모든 수동 Sync/dry-run에 검토한 정확한 40자리 SHA를 지정한다.
2. **격리 테스트:** 관리자가 Restricted namespace와 단계 1 권한을 준비한다. 시험 Pod는 공개 Python digest `sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de`, `IfNotPresent`로 worker-02에서 실행하며 private Agent 이미지를 사용하지 않는다. 허용 대상이 ConfigMap/Deployment 각 1개뿐인지 확인한 뒤 해당 SHA로 수동 Sync한다. 첫 Sync의 Synced/Healthy를 확인했다. HTTP 응답과 production 무변경 증거를 함께 기록한다.
3. **수동 변경 증명:** 별도 Git commit에서 테스트 ConfigMap의 message만 v2로 변경한다. 자동 적용되지 않고 OutOfSync가 되는지 관찰한다. 수동 sync 후 mounted ConfigMap 갱신과 HTTP v2를 확인한다. 이 과정에서 테스트 Pod UID가 유지되는지 확인한다. 삭제/정리는 controller delete 권한을 늘리는 대신 별도 관리자 승인 범위로 다룬다.
4. **운영 사전 비교:** Helm release/values/manifest와 live 리소스를 새로 조회한다. Secret 리소스·DB 데이터는 조회하지 않고 공개 metadata와 참조 이름으로 확인한다. Deployment/DaemonSet UID·generation·Pod template hash·replica·Pod UID/node/imageID/restart와 DB StatefulSet/PVC UID/volumeName을 기록한다. 정확한 기존 리소스·현재 ReplicaSet의 최상위 metadata와 Helm 복구 자료는 비밀 입력과 분리된 암호화 backup으로 보관한다. 값이나 이미지가 저장된 후보와 달라졌으면 새 diff로 다시 검토한다.
5. **운영 채택 승인:** Platform과 Agent는 별도 승인 범위로 다룬다. 승인 전 정확한 SHA의 Argo compare와 API server dry-run에서 Deployment/DaemonSet의 `spec` 및 `spec.template`, Service/Ingress/NetworkPolicy/monitoring spec 차이가 **0**이어야 한다. Argo 자체 dry-run은 client 모드이므로 admission·실제 CSA patch 확인을 대신하지 못한다. 정확한 tracking 문서만 `kubectl apply --dry-run=server --field-manager=argocd-controller`로 미리보고 반환 spec이 live와 같은지 확인한다. 예정 변경은 최상위 tracking/last-applied metadata뿐이다. ReplicaSet/Pod 생성, Hook task, DB/PVC/Secret 대상, replace/force/prune/delete가 있으면 중단한다. 구체적 diff를 준비한 다음 해당 운영 소유권 전환 승인을 받는다.
6. **수동 채택과 결과 확인:** 승인이 있으면 승인된 앱만 prune/force/replace 없이 정확한 SHA로 수동 Sync한다. 직후 기존 리소스·Pod/ReplicaSet UID, 전체 spec/template hash, imageID/restart를 대조한다. Deployment는 최상위 annotation만 바뀌어도 generation이 증가할 수 있으므로 generation 자체의 동일성을 요구하지 않고 승인된 metadata 변화와 observedGeneration 수렴을 확인한다. Platform Ready 2개, 기존 Agent Ready 1개, HTTPS `/health/ready`, monitoring 연결, DB/PVC 불변을 확인한다. 검증 전 zero-restart 채택 완료라고 기록하지 않는다.

단계 4~6에서 차이가 나면 그 상태에서 중단한다. NFS·storage·RBAC 확대나 리소스 재생성으로 맞추지 않는다. Argo Application을 제거해야 하는 경우 finalizer 및 deletion 동작을 확인한 별도 비연쇄 절차로 검토한다. 기존 운영 워크로드나 Helm release를 지우는 복구 절차는 포함하지 않는다.

복귀는 추가 Sync 통제·운영 RoleBinding 회수·Application 비연쇄 분리 뒤, 새로 추가한 최상위 관리 annotation만 UID/resourceVersion 조건으로 원래대로 복구하는 범위로 검토한다. Deployment controller가 tracking annotation을 기존 ReplicaSet에도 복사하고 제거는 전파하지 않을 수 있어, 그 metadata까지 되돌릴 때는 별도 관리자 최소 patch가 필요하다. Argo에 ReplicaSet 쓰기 권한을 추가하거나 Helm rollback/uninstall로 되돌리지 않는다. generation/resourceVersion/managedFields를 과거 값으로 덮어쓰지 않는다. [Kubernetes generation 규칙](https://github.com/kubernetes/kubernetes/blob/v1.36.5/pkg/registry/apps/deployment/strategy.go#L99-L110), [ReplicaSet annotation 복사](https://github.com/kubernetes/kubernetes/blob/v1.36.5/pkg/controller/deployment/util/deployment_util.go#L275-L308), [Argo client dry-run](https://github.com/argoproj/argo-cd/blob/v3.5.5/gitops-engine/pkg/sync/sync_context.go#L1282-L1288).

## 5. 실제 완료 결과와 남은 범위

`validation/local-validation.json`에 로컬 검증을 기록했다. Platform 9개 문서 중 Skip Job을 제외한 대상은 8개, Agent는 3개다. 저장된 후보와 비교했을 때 Platform의 Hook annotation 외 전체 필드가 같고 Agent는 전체 필드가 같다. DB/PVC/Secret/StatefulSet/Namespace/RBAC는 렌더링되지 않았다. 테스트의 보안 설정은 정적으로 확인했다.

이 최초 로컬 검증 기록은 당시 후보 기준이다. 이후 실제 Argo 설치·read-only Git fetch·시험 v2 자동 미적용/정확한 SHA 수동 적용을 검증했다. 시험 Pod `rca-gitops-proof-55cb7c5bb4-nhbtc`의 UID `926c67e8-1cf8-422c-bd97-9e3bce7fedeb`와 restart 0을 유지하면서 HTTP 메시지가 v1→v2로 바뀌었다. 공개 Python/IfNotPresent 설정은 최초 Agent-image 재사용안과 구분한다.

Platform 8개는 Helm revision 4의 manifest·raw spec hash·공개 values와 같았고, API server dry-run도 전체 spec 불변을 확인했다. 승인한 SHA `8efe20a93373ecb65c82566331e7582f33d574ec`의 실제 수동 Sync 8개 작업이 성공했다. Deployment generation 3→4는 최상위 annotation 변화이며 기존 Platform Pod 2개 UID/imageID/restart 0, 세 ReplicaSet UID/spec, DB StatefulSet/PVC와 Helm revision 4가 보존됐다. Prometheus 대상 2개 UP, 사설 CA/SNI를 확인한 HTTPS live/ready 200과 React/인증 경로도 확인했다. CP→서비스 ClusterIP의 직접 HTTP는 접근되지 않았으며 그 경로를 열지 않았다.

도입 직후 전체 Synced/Healthy와 달리 개별 7종은 Unknown이었다. 등록된 시험 namespace에서 정확한 7종 list가 거부되고 운영 namespace에서는 허용되는 사실을 확인했다. `respectRBAC=normal`의 전역 kind 분류 경로와 일치해, 신규 시험 namespace의 해당 7종 get/list/watch만 별도 Role로 추가하고 지원 API로 cluster cache를 갱신했다. 이후 **8개 모두 개별 Synced**, 전체 Synced/Healthy를 확인했다. 운영 권한·쓰기 확대나 workload 재시작은 없었다. preflight Job ExcludedResourceWarning 하나는 의도한 제외이며 audit 실행 완료를 뜻하지 않는다.

Agent의 Argo 등록·권한·채택은 미승인이다. 완전한 Jenkins runtime·Registry 이미지 publish·새 digest의 GitOps PR 처리 결과는 실제 CI 증거로 별도 확인한다. 소스 저장소의 `c480483` 기존 feature ref push는 Rule Suite에서 **bypass**로 기록됐으며 이를 정상적인 보호 통과나 독립 승인으로 표현하지 않는다. 후속 소스 변경은 해당 저장소의 보호 규칙을 따르는 PR 경로로 검토한다.
