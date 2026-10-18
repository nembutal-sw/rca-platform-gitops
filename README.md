# RCA Platform on-prem GitOps

온프레미스 RCA의 공개 GitOps 저장소다. 내부 주소·hostname·배포 설정 공개를 명시적으로 승인받았으며 인증 값은 포함하지 않는다. Argo CD의 repository URL은 `ssh://git@ssh.github.com:443/nembutal-sw/rca-platform-gitops.git`이고 read-only deploy key로 연결했다. Argo CD **v3.5.5 / Helm Chart 10.10.5**가 namespace `argocd`에서 네 Pod Ready이며 TLS·관리자 초기 비밀번호 교체를 확인했다.

Platform은 승인한 commit **`8efe20a93373ecb65c82566331e7582f33d574ec`**으로 metadata만 채택했다. 8개 작업이 성공했고 8개 리소스 모두 개별 Synced, 전체 Synced/Healthy다. 기존 Platform Pod 2개의 UID·imageID·restart 0과 DB/PVC를 보존했다. 기존 Helm release `rca` **revision 4는 보존·동결**하며 같은 리소스의 Helm upgrade/rollback/uninstall을 실행하지 않는다. Agent의 Argo 채택은 별도 미승인 상태다.

시험 앱은 main의 v2 변경이 자동 적용되지 않음을 확인한 뒤 해당 SHA로 수동 Sync했다. 동일 Pod UID와 restart 0에서 HTTP 메시지가 v1→v2로 바뀌었다. 이 시험과 운영 채택 모두 자동 Sync 없이 수행했다.

Application의 `targetRevision`은 `main`을 유지한다. PR merge 뒤 **OutOfSync만 표시**하고 자동 적용하지 않는다. **모든 수동 Sync와 dry-run에는 검토한 정확한 40자리 commit SHA를 지정**한다. main의 최신값을 암묵적으로 적용하지 않는다.

이 GitOps 저장소의 main은 PR 필수, 관리자에게도 적용, force push/삭제 금지다. 사용자가 단독 소유자라 독립 승인자를 충족할 수 없는 점을 확인해 required review count는 **0**으로 설정했다. 독립 검토를 받았다고 표현하지 않는다. 자동 merge와 Argo auto-sync는 설정하지 않았다. 소스 저장소의 별도 보호 규칙과 혼동하지 않는다.

## 디렉터리와 경계

| 경로 | 목적 | 적용 시점 |
| --- | --- | --- |
| `applications/onprem/gitops-test` | ConfigMap 1개와 Restricted Deployment 1개 | 별도 `rca-gitops-test`에서 수동 검증 |
| `applications/onprem/platform` | 기존 Helm `rca`와 동일한 Chart/배포 값 | 승인한 SHA로 metadata 채택 완료 |
| `applications/onprem/agent` | 기존 Helm `rca-agent-canary`의 safe canary Chart/배포 값 | 별도 소유권 전환 승인 후 |
| `environments/onprem/platform/values.yaml` | Platform 환경의 실제 배포 값; CI digest PR 경로 | 기존 배포 값과 동일한 초기값 |
| `environments/onprem/agent/values.yaml` | worker-02 canary의 실제 배포 값 | 기존 배포 값과 동일한 초기값 |
| `bootstrap/stage-1-test` | 테스트 전용 AppProject/Application | 저장소·Argo·namespace 준비 후 |
| `bootstrap/stage-2-production-review` | 운영용 AppProject/Application | Platform만 승인·등록; Agent 별도 승인 필요 |
| `bootstrap/argocd` | 설치한 Argo의 공개 version pin·CRD·values·최소 권한 | 관리자 단계별 검토용; 일괄 적용 금지 |
| `review` | Hook 변경 diff, 소유권 전환 계획 | 검토 자료 |
| `validation` | 로컬 lint/render 및 저장된 후보와의 전체 필드 비교 | 클러스터 검증을 대체하지 않음 |

각 Application은 지정한 경로 하나만 읽는다. 이 저장소 루트나 `bootstrap`을 재귀 적용하거나 app-of-apps로 등록하지 않는다. stage-2 폴더 전체를 적용해 미승인 Agent Application을 등록하지 않는다. Argo CD 설치, CRD bootstrap, namespace Role/Binding, 저장소 인증은 별도 관리자 작업이다. [공개 Argo bootstrap](bootstrap/argocd/README.md)에는 chart binary·실제 Secret data·키가 없다.

플랫폼/Agent Chart는 기존 검토 묶음의 사본이다. Platform Chart의 유일한 수정은 `rca-agent-enrollment-preflight` Job에 붙인 `argocd.argoproj.io/hook: Skip`이며 [검토 diff](review/platform-hook-skip.diff)에 분리했다. Agent Chart와 실제 배포 값은 저장된 후보와 동일하다. 전체 Chart에 선택적 DB/Secret/RBAC 템플릿이 있어도 제공된 값에서는 렌더링되지 않으며 Project/namespace RBAC의 허용 대상도 아니다.

## 고정한 값

- Platform: `10.7.254.6:5000/rca-platform@sha256:027e98ca59439c4398f177d48e2d017712e70728fb3327b17edb4ed8a02cb5f4`, Helm release `rca`, namespace `rca-system`, replica 2.
- Agent: `10.7.254.6:5000/rca-node-agent:git-af730cd65758-r2@sha256:dde674dda41eb656757d7507c68c1f78c4184e893654f42f750858919557625c`, Helm release `rca-agent-canary`, namespace `rca-system`, `k8s-worker-02` 1개 노드.
- 기존 DB/PVC/Secret, 관리자 Node reader ClusterRole/Binding, 영구 인프라 PrometheusRule은 이번 채택 대상에서 제외한다.

Agent의 위 private digest는 운영 canary의 값이다. 별도 시험 Deployment는 공개 Python 이미지 `docker.io/library/python@sha256:57cd7c3a7a273101a6485ba99423ee568157882804b1124b4dd04266317710de`와 `imagePullPolicy: IfNotPresent`를 사용한다. worker-02에만 배치하고 `python -c`로 ConfigMap의 메시지를 HTTP로 응답한다. 시험 namespace는 Restricted 정책을 적용하며 private Registry credential을 복사하지 않는다. 시험 앱의 공개 이미지 설정을 운영 Agent 이미지와 혼동하지 않는다.

## 로컬 검증

`validation/verify-review.mjs`는 기존 로컬 Helm 실행 파일로 후보와 초안을 렌더링하고 모든 필드를 구조적으로 비교한다. 클러스터 명령은 포함하지 않는다. 결과는 [local-validation.json](validation/local-validation.json)에 기록한다. 검증용 Node 실행 파일은 현재 PC의 bundled runtime을 사용했다.

로컬 검증 기록은 Helm 3.17.3 / Kubernetes 1.36.5 lint/render와 최초 후보의 정적 비교를 담는다. 이후 실제 Argo 설치·Git fetch·시험 v2 수동 적용과 동일 Pod 보존, 운영 Platform 8개의 Helm revision 4 일치·Argo diff·API server dry-run·승인된 수동 채택을 확인했다. 기존 8개 UID와 spec·Pod/ReplicaSet·DB/PVC를 보존했고 Prometheus 2 UP와 사설 CA/SNI를 검증한 HTTPS health도 확인했다. CP에서 서비스 ClusterIP로 직접 보내는 HTTP는 접근되지 않았으며 해당 경로를 열지 않았다.

도입 직후 개별 7종 Unknown은 두 등록 namespace의 조회 권한 차이와 Argo 3.5.5의 RBAC cache 분류 경로에 해당했다. 신규 시험 namespace에 해당 7종의 get/list/watch만 추가하고 공식 API로 cache를 갱신한 뒤 **8개 모두 개별 Synced**를 확인했다. 운영 권한이나 쓰기는 넓히지 않았고 Pod 재시작은 없었다. 제외한 `rca-agent-enrollment-preflight` Job의 경고 1개는 의도한 상태다. Skip은 enrollment audit를 실행했다는 뜻이 아니므로 관련 변경 시 별도 수동 점검이 필요하다.

운영 채택 조건과 중단 기준은 [소유권 전환 계획](review/ownership-transition.md)을 따른다.
