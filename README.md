# RCA Platform private GitOps review bundle

검토용 로컬 초안이다. 대상 private 저장소는 `https://github.com/nembutal-sw/rca-platform-gitops`이며 저장소 생성과 push는 상위 작업에서 관리한다. 이 파일 묶음을 만든 하위 작업은 클러스터 접속·Application 등록·sync를 수행하지 않았다. 모든 Application의 `targetRevision`은 검토할 실제 Git commit SHA로 교체하기 전에는 사용할 수 없다.

## 디렉터리와 경계

| 경로 | 목적 | 적용 시점 |
| --- | --- | --- |
| `applications/onprem/gitops-test` | ConfigMap 1개와 Restricted Deployment 1개 | 별도 `rca-gitops-test`에서 수동 검증 |
| `applications/onprem/platform` | 기존 Helm `rca`와 동일한 Chart/배포 값 | 별도 소유권 전환 승인 후 |
| `applications/onprem/agent` | 기존 Helm `rca-agent-canary`의 safe canary Chart/배포 값 | 별도 소유권 전환 승인 후 |
| `environments/onprem/platform/values.yaml` | Platform 환경의 실제 배포 값; CI digest PR 경로 | 기존 배포 값과 동일한 초기값 |
| `environments/onprem/agent/values.yaml` | worker-02 canary의 실제 배포 값 | 기존 배포 값과 동일한 초기값 |
| `bootstrap/stage-1-test` | 테스트 전용 AppProject/Application | 저장소·Argo·namespace 준비 후 |
| `bootstrap/stage-2-production-review` | 운영용 AppProject/Application 검토안 | 테스트와 운영 diff 검토 후 |
| `review` | Hook 변경 diff, 소유권 전환 계획 | 검토 자료 |
| `validation` | 로컬 lint/render 및 저장된 후보와의 전체 필드 비교 | 클러스터 검증을 대체하지 않음 |

각 Application은 지정한 경로 하나만 읽는다. 이 저장소 루트나 `bootstrap`을 재귀 적용하거나 app-of-apps로 등록하지 않는다. Argo CD 설치, CRD bootstrap, namespace Role/Binding, 저장소 인증은 별도 관리자 작업이다. 이 묶음에는 인증 값이 없다.

플랫폼/Agent Chart는 기존 검토 묶음의 사본이다. Platform Chart의 유일한 수정은 `rca-agent-enrollment-preflight` Job에 붙인 `argocd.argoproj.io/hook: Skip`이며 [검토 diff](review/platform-hook-skip.diff)에 분리했다. Agent Chart와 실제 배포 값은 저장된 후보와 동일하다. 전체 Chart에 선택적 DB/Secret/RBAC 템플릿이 있어도 제공된 값에서는 렌더링되지 않으며 Project/namespace RBAC의 허용 대상도 아니다.

## 고정한 값

- Platform: `10.7.254.6:5000/rca-platform@sha256:027e98ca59439c4398f177d48e2d017712e70728fb3327b17edb4ed8a02cb5f4`, Helm release `rca`, namespace `rca-system`, replica 2.
- Agent: `10.7.254.6:5000/rca-node-agent:git-af730cd65758-r2@sha256:dde674dda41eb656757d7507c68c1f78c4184e893654f42f750858919557625c`, Helm release `rca-agent-canary`, namespace `rca-system`, `k8s-worker-02` 1개 노드.
- 기존 DB/PVC/Secret, 관리자 Node reader ClusterRole/Binding, 영구 인프라 PrometheusRule은 이번 채택 대상에서 제외한다.

Agent digest와 Python 사용 가능성은 기존 `agent-image-provenance.json`, `agent-runtime-validation.json`과 현재 후보의 값에 근거한다. 테스트 Deployment는 해당 이미지를 재사용하고 `python -c`로 작은 HTTP 응답만 실행한다. `imagePullPolicy: Never`로 레지스트리 인증을 복사하지 않는다. 실행 전 worker-02에서 같은 이미지가 여전히 캐시되어 있는지 확인해야 한다. 캐시가 없으면 `ErrImageNeverPull`로 중단하고 임의 이미지나 인증 복사를 추가하지 않는다. 테스트 namespace에도 기존 Restricted 정책을 적용하는 관리자 준비가 필요하다.

## 로컬 검증

`validation/verify-review.mjs`는 기존 로컬 Helm 실행 파일로 후보와 초안을 렌더링하고 모든 필드를 구조적으로 비교한다. 클러스터 명령은 포함하지 않는다. 결과는 [local-validation.json](validation/local-validation.json)에 기록한다. 검증용 Node 실행 파일은 현재 PC의 bundled runtime을 사용했다.

확인 범위는 Helm 3.17.3 / Kubernetes 1.36.5 대상으로 한 lint/render, Application/Project의 제한 설정, 테스트 Pod의 Restricted 정적 요건, 기존 후보와의 차이다. 실제 Argo CD 3.5.5의 Helm 4 렌더링, CRD admission, cache/RBAC, live diff와 수동 sync는 아직 검증하지 않았다. 등록 전 이 차이를 해소해야 한다.

운영 채택 조건과 중단 기준은 [소유권 전환 계획](review/ownership-transition.md)을 따른다.
