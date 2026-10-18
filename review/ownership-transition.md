# 기존 Helm RCA 리소스의 Argo CD 채택 검토안

2026-10-18 기준 로컬 검토 자료다. 운영 소유권 전환이나 sync를 완료했다는 기록이 아니다. 기존 읽기 전용 후보의 upstream 기준은 `af730cd657581dde532526be04b6478555351c52`다. Argo CD 설치 검토 버전은 3.5.5 / Helm Chart 10.10.5이며 설치·권한 매니페스트는 별도 `argo-review` 작업의 범위다.

## 1. 관리 대상과 권한

| Application | source path | destination | Helm release | 수동 채택 대상 |
| --- | --- | --- | --- | --- |
| `rca-gitops-proof` | `applications/onprem/gitops-test` | `rca-gitops-test` | 해당 없음 | ConfigMap/Deployment `rca-gitops-proof` |
| `rca-platform-onprem` | `applications/onprem/platform/chart` | `rca-system` | `rca` | SA, Service, Deployment, Ingress, NetworkPolicy, PDB `rca-platform`; ServiceMonitor `rca`; AlertmanagerConfig `rca-webhook` |
| `rca-agent-canary-onprem` | `applications/onprem/agent/chart` | `rca-system` | `rca-agent-canary` | SA/DaemonSet `rca-agent-canary`; ConfigMap `rca-agent-canary-config` |

AppProject는 저장소를 `https://github.com/nembutal-sw/rca-platform-gitops.git` 하나로, 목적지를 명시한 클러스터/namespace 하나로 제한한다. clusterResourceWhitelist는 빈 목록이며 namespaceResourceWhitelist에는 표의 resource group/kind만 넣었다. `default` Project의 광범위 기본 권한을 RCA 앱에 사용하지 않는다. AppProject 정책과 Kubernetes Role은 별도 방어 계층이다. [공식 Projects 설명](https://argo-cd.readthedocs.io/en/stable/user-guide/projects/), [Project 명세](https://argo-cd.readthedocs.io/en/stable/operator-manual/project-specification/).

**이름은 검토 inventory이며 AppProject가 강제하는 이름 제한이 아니다.** v3.5.5 CRD에서 namespaceResourceWhitelist 항목은 `group`/`kind`만 지원하고 `name`은 cluster resource 제한에서만 지원한다. 따라서 허용된 kind의 다른 이름이 추가되면 Git 검토 및 등록 전 inventory 검사로 중단한다. Project나 Application을 임의 변경할 CI 권한을 부여하지 않는다. [v3.5.5 공식 AppProject CRD](https://raw.githubusercontent.com/argoproj/argo-cd/v3.5.5/manifests/crds/appproject-crd.yaml).

단계 1에서는 controller의 대상 namespace를 `rca-gitops-test` 하나로 제한한다. 테스트 성공과 운영 소유권 전환 검토 후에만 별도로 승인한 `rca-system` Role/Binding 및 cache 범위를 추가한다. 운영 Role에서도 Secret/PVC/StatefulSet/Job/RBAC 쓰기와 리소스 delete를 허용하지 않는다. AppProject 제한을 controller의 넓은 ClusterRole 대신으로 간주하지 않는다.

다음 리소스는 GitOps 채택·추적·쓰기 대상에서 제외한다.

- PostgreSQL StatefulSet/Service/ConfigMap/SA/NetworkPolicy와 `rca-postgres-data` PVC.
- 런타임·Registry·TLS·DB·bootstrap Secret 및 Helm release Secret/history.
- PV, StorageClass, NFS export/권한/방화벽, Namespace, CRD, ClusterRole/Binding.
- 기존 관리자 Node reader 권한과 영구 `rca-agent-canary-infrastructure` PrometheusRule.

## 2. 수동 sync와 추적 방식

모든 Application은 `automated`와 finalizer를 생략했다. `CreateNamespace`, managedNamespaceMetadata, 광범위 ignoreDifferences도 없다. syncOptions는 `Prune=false`, `Delete=false`, `FailOnSharedResource=true`, `Replace=false`, `ServerSideApply=false`다. 3.5.5에서 앞 두 옵션은 Application 기본 정책으로 설정할 수 있다. 리소스에 별도 Prune/Delete 옵션을 추가하면 기본값을 덮어쓸 수 있으므로 해당 변경도 금지한다. [공식 자동 sync 정책](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/), [Sync 옵션](https://argo-cd.readthedocs.io/en/stable/user-guide/sync-options/), [Application 삭제](https://argo-cd.readthedocs.io/en/stable/user-guide/app_deletion/).

설치 시 `argocd-cm`의 `application.resourceTrackingMethod: annotation`을 명시적으로 확인한다. `annotation+label`이나 기본 instance label 추적을 사용하지 않는다. Helm release 이름을 명시했으므로 `app.kubernetes.io/instance=rca`와 `rca-agent-canary`를 그대로 유지한다. 이 값은 Deployment/DaemonSet selector, Service selector 및 Platform topology spread에 사용된다. 추적 방식이 annotation이면 Argo의 최상위 tracking-id annotation으로 소유 관계를 표시할 수 있다. [공식 Resource Tracking](https://argo-cd.readthedocs.io/en/stable/user-guide/resource_tracking/).

Argo CD는 Helm을 manifest 생성에 사용하며 Helm release 이력을 이어 쓰지 않는다. 기존 Helm labels/annotations와 release Secret을 제거하거나 Helm uninstall하지 않는다. 채택 후 Jenkins/운영자가 같은 릴리스에 `helm upgrade`를 실행하면 두 관리 주체가 충돌할 수 있다. CI는 빌드·검증·digest 변경 PR까지만 담당하고 운영 apply/upgrade는 중지한다. 비상 복귀 시에도 먼저 Argo 수동 sync 권한과 실행 중 작업을 통제하고 별도 검토한다. [공식 Helm 통합 설명](https://argo-cd.readthedocs.io/en/stable/user-guide/helm/).

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

Argo의 Skip은 live lookup 생략을 뜻하지 않는다. v3.5.5 cache는 watch하지 않는 desired kind를 직접 GET할 수 있으므로 Job 읽기까지 전부 금지하면 비교 단계가 실패할 수 있다. 단계 2에서 필요하면 `batch/jobs`의 `get`만 `resourceNames: [rca-agent-enrollment-preflight]`로 제한해 별도 검토한다. list/watch/create/update/patch/delete는 추가하지 않는다. 또는 Job을 렌더링하지 않는 `enabled=false` 변경안을 검토한다. 이 둘의 실제 검증 전에는 Skip만으로 비교가 성공한다고 주장하지 않는다. [v3.5.5 cache의 직접 GET](https://github.com/argoproj/argo-cd/blob/v3.5.5/gitops-engine/pkg/cache/cluster.go#L1472).

## 4. 검토 가능한 단계와 승인 조건

1. **로컬 준비:** Chart 사본, 공개 배포 값, Hook diff, lint/render 결과를 검토한다. 예정 private 저장소 생성/push 전 비밀값 검사를 수행하고 저장소에 소스 경로만 올린다. 각 Application의 revision을 검토한 실제 40자리 commit SHA로 고정한다. placeholder나 움직이는 branch로 운영 Application을 등록하지 않는다.
2. **격리 테스트:** 관리자가 Restricted namespace와 단계 1 권한을 준비한다. worker-02의 정확한 Python 이미지 캐시를 확인한다. 테스트 Project/Application만 등록하고 먼저 compare한다. 허용 대상이 ConfigMap/Deployment 각 1개뿐인지 확인한 뒤 별도로 승인된 수동 sync를 실행한다. Ready 1개, HTTP 응답 `rca-gitops-proof-v1`, production 리소스 변화 없음이 합격 조건이다.
3. **수동 변경 증명:** 별도 Git commit에서 테스트 ConfigMap의 message만 v2로 변경한다. 자동 적용되지 않고 OutOfSync가 되는지 관찰한다. 수동 sync 후 mounted ConfigMap 갱신과 HTTP v2를 확인한다. 이 과정에서 테스트 Pod UID가 유지되는지 확인한다. 삭제/정리는 controller delete 권한을 늘리는 대신 별도 관리자 승인 범위로 다룬다.
4. **운영 사전 비교:** 승인된 단계 2 읽기 범위에서 Helm release/values/manifest와 live 리소스를 새로 조회한다. DB/PVC/Secrets 데이터는 조회·export하지 않고 공개 metadata와 참조 이름으로 확인한다. 현재 Deployment/DaemonSet UID·generation·Pod template hash·replica·Pod UID/node/imageID/restart를 기록하고 DB StatefulSet/PVC UID/volumeName의 보존 기준도 기록한다. 값이나 이미지가 저장된 후보와 달라졌으면 이를 숨기지 않고 새 diff로 다시 검토한다.
5. **운영 채택 승인:** 두 Application을 등록하되 sync하지 않고 정확한 pinned revision에서 비교한다. Deployment/DaemonSet의 `spec` 및 `spec.template`, Service/Ingress/NetworkPolicy/monitoring spec 차이가 **0**이어야 한다. 예정 변경은 추적/last-applied 등 최상위 관리 metadata뿐이다. ReplicaSet/Pod 생성, Hook task, DB/PVC/Secret 대상, replace/force/prune/delete 작업이 있으면 중단한다. Application/Project/RBAC와 이 구체적 diff가 준비된 다음 운영 소유권 전환 승인을 받는다.
6. **수동 채택과 결과 확인:** 승인이 있으면 production 앱을 하나씩, prune/force/replace 없이 해당 revision으로 수동 sync한다. 각 앱 직후 동일 UID·generation·template hash와 Pod UID/imageID/restart를 대조한다. Platform Ready 2개, Agent Ready 1개, HTTPS `/health/ready`, 기존 monitoring 연결, DB/PVC 불변을 확인한다. 이 검증이 끝나기 전 zero-restart 채택 완료라고 기록하지 않는다.

단계 4~6에서 차이가 나면 그 상태에서 중단한다. NFS·storage·RBAC 확대나 리소스 재생성으로 맞추지 않는다. Argo Application을 제거해야 하는 경우 finalizer 및 deletion 동작을 확인한 별도 비연쇄 절차로 검토한다. 기존 운영 워크로드나 Helm release를 지우는 복구 절차는 포함하지 않는다.

## 5. 현재 검증과 미완료 항목

`validation/local-validation.json`에 로컬 검증을 기록했다. Platform 9개 문서 중 Skip Job을 제외한 대상은 8개, Agent는 3개다. 저장된 후보와 비교했을 때 Platform의 Hook annotation 외 전체 필드가 같고 Agent는 전체 필드가 같다. DB/PVC/Secret/StatefulSet/Namespace/RBAC는 렌더링되지 않았다. 테스트의 보안 설정은 정적으로 확인했다.

이는 live state와 같다는 증거가 아니다. private 저장소 생성/push, actual Git SHA 고정, Argo CD 3.5.5 Helm 4 렌더 비교, API/CRD admission, controller cache/RBAC, 이미지 캐시 현재 상태, 테스트 수동 sync, production diff·소유권 승인·sync는 이 하위 작업에서 수행하지 않았다.
