# Argo CD 공개 bootstrap 설정

실제 설치한 단일 Argo CD **v3.5.5 / Helm chart 10.10.5**의 공개 설정이다. Kubernetes 1.36.5, namespace `argocd`, worker `k8s-worker-02`를 대상으로 한다. Chart는 4개 활성 Pod와 replica 0인 ApplicationSet을 렌더하며 Dex/notifications/Ingress/외부 LoadBalancer를 끈다. Service는 ClusterIP이고 TLS·로그인을 사용한다. 기존 워크로드는 이 경로의 관리 대상이 아니다.

이 디렉터리는 관리자 bootstrap 자료다. Application source로 등록하거나 디렉터리 전체를 일괄 apply하지 않는다. CRD·namespace·권한·Helm 설치·운영 전환을 단계별로 검토한다. 실제로 이미 존재하는 namespace/CRD/release를 신규 설치 명령으로 덮어쓰지 않는다.

## 고정 버전과 무결성

- 공식 archive: `https://github.com/argoproj/argo-helm/releases/download/argo-cd-10.10.5/argo-cd-10.10.5.tgz`
- 공식 chart SHA-256: `ba6447eeed42bc41d1f0527721047b236304e97669a7b6286d02be4a1644ba7a`
- `crds-argocd-v3.5.5.yaml` SHA-256: `c89a53090577a1f5852e97b5be49bdde082e5495d262b7ba2bc5629c3dae4f6c`
- CRD 파일에는 Application/AppProject/ApplicationSet의 세 schema만 있다. Helm의 CRD 자동 설치는 껐다.

Chart archive/binary는 저장소에 넣지 않는다. 내려받은 archive의 SHA를 위 값과 대조한 뒤 정확한 version으로 렌더·검토한다. [공식 chart](https://github.com/argoproj/argo-helm/releases/tag/argo-cd-10.10.5), [Kubernetes 지원 표](https://argo-cd.readthedocs.io/en/stable/operator-manual/installation/#tested-versions)

## 파일과 적용 순서

| 파일 | 범위 |
| --- | --- |
| `namespaces.yaml` | 신규 argocd/test namespace의 Restricted PSS v1.36 |
| `crds-argocd-v3.5.5.yaml` | 관리자 단계의 정확한 3개 CRD; 기존 CRD 덮어쓰기 금지 |
| `default-project-deny.yaml` | default Project의 광범위 허용 차단 |
| `target-test-access.yaml` | 시험 ConfigMap/Deployment와 관찰에 필요한 namespace 권한 |
| `values-stage1.yaml` | 정확한 chart의 초기 설치 값; test namespace cache만 등록 |
| `target-platform-access.yaml` | 승인된 기존 Platform 8개 이름의 get/update/patch와 읽기 전용 비교 |
| `values-stage2-platform.yaml` | stage1 뒤 겹쳐서 cache에 rca-system 추가; 자동 Sync 없음 |
| `target-test-discovery-readonly.yaml` | 두 namespace cache의 kind 분류를 맞추는 시험 namespace 7종 읽기 |

초기 설치에서 target-platform Role과 stage2 overlay를 자동 적용하지 않는다. 운영 채택은 정확한 검토 commit의 live/Helm/Argo diff와 server dry-run에서 spec 불변을 확인한 뒤 승인한 Platform에만 수행했다. Agent 전환 권한 파일은 이 경로에 없으며 자동으로 부여하지 않는다.

Chart `createClusterRoles=false`, `createAggregateRoles=false`를 유지한다. 운영 Role은 정확한 기존 이름에만 update/patch를 허용하며 create/delete·Agent·DB/PVC/Secret/StatefulSet/RBAC 쓰기는 허용하지 않는다. 이 RBAC가 patch 필드를 metadata로 제한하는 것은 아니므로, 실제 full-spec diff·수동 Sync revision 검토는 계속 필요하다.

시험 discovery Role은 **rca-gitops-test 안에서만** Service/ServiceAccount/Ingress/NetworkPolicy/PDB/ServiceMonitor/AlertmanagerConfig의 get/list/watch를 허용한다. 쓰기·Secret·운영 namespace·클러스터 권한은 없다. `resource.respectRBAC=normal`은 등록된 namespace 중 하나에서 kind list가 Forbidden이면 분류를 제거할 수 있어 이 읽기 차이를 정합화했다. 공식 cache 갱신 후 Platform 8개 모두 개별 Synced, 전체 Synced/Healthy를 확인했다. [Argo v3.5.5 처리](https://github.com/argoproj/argo-cd/blob/v3.5.5/gitops-engine/pkg/cache/cluster.go#L1177-L1193)

## 인증과 운영 경계

비밀번호·token·admin hash·Redis auth·GitHub deploy key·Registry/TLS/애플리케이션 Secret data는 이 저장소에 없다. stage1 values의 cluster 등록은 클러스터 URL/namespace/CA 검증 설정만 포함하며 static bearer token을 저장하지 않는다. runtime Secret의 빈 초기 설정은 chart 설정이며 실제 인증 값은 별도 보호 경로에서 생성한다. GitHub는 SSH 443 URL과 별도 read-only deploy key로 연결한다.

새 설치에서는 chart 초기화 Job을 켜는 대신 `argocd` namespace의 `argocd-redis` Secret `auth`를 32자 이상 독립 난수로 보호된 비밀 경로에서 먼저 준비한다. Argo admin 초기 인증은 보호된 경로로 수령해 즉시 교체하고, 저장소 read-only deploy key도 별도로 등록한다. 실제 값이나 인증 파일을 이 디렉터리에 만들지 않는다.

Application은 `main`을 수동 추적하고 모든 Sync/dry-run에 검토한 정확한 SHA를 지정한다. 자동 sync/prune/self-heal/CreateNamespace/finalizer/강제 교체를 추가하지 않는다. 기존 Helm `rca` revision 4는 복구 이력으로 보존·동결했으며 같은 리소스에 Helm upgrade/rollback/uninstall을 실행하지 않는다. DB/PVC/Secret/NFS는 채택하지 않는다.

설정 정합화 뒤 cache만 재구축하려면 인증된 Argo API의 `POST /api/v1/clusters/onprem-rca-scoped/invalidate-cache?id.type=name`를 사용한다. 먼저 실제 등록 이름을 확인하고 clusters update 권한이 있는 담당자가 실행한다. 이 API는 등록 정보 refresh timestamp를 바꾸며 workload를 재시작하지 않는다. 비밀번호나 token을 명령행에 넣지 않는다. [정확한 API 정의](https://github.com/argoproj/argo-cd/blob/v3.5.5/server/cluster/cluster.proto)
