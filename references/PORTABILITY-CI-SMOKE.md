# PORTABILITY-CI-SMOKE — §1.3 weekly fresh-clone rebuild job 模板

> 對應 `09-PROJECT-PORTABILITY.md` §1.3:可重建性是 **invariant,不是 milestone**。
> 一次性手動 smoke 只證明「採用時可建」;**CI weekly job** 才是「持續保證可建」。
> 本檔給消費者一個可直接 instantiate 的 GitHub Actions 模板。

## 為什麼 weekly(不是 only-on-push)

可重建性衰敗是隱性的:加一個 secret、新 migration、新 binding,半年前手動 smoke 紀錄就過期。
push 觸發的 CI 只驗「當次改動」,不會抓「累積漂移導致 fresh clone 拉不起來」。weekly 從乾淨狀態重跑,專抓這類衰敗。

## 模板(GitHub Actions,消費者 instantiate)

> 放消費者 `.github/workflows/portability-smoke.yml`。棧差異:`setup-node`/`setup-python` 二選一;CF 專案多一步 `wrangler whoami`。
> **[MUST]** job 呼叫 manifest 的 `scripts/bootstrap.sh` + `scripts/portability-smoke.sh`(同一入口,§D manifest-consumed)——**[NEVER]** 在 CI yaml 另立平行 bootstrap 步驟(否則 manifest 與 CI 各自演化)。

```yaml
name: portability-fresh-clone-smoke
on:
  schedule:
    - cron: '17 3 * * 1'   # weekly Monday ~03:17 UTC(錯開整點,避開擁擠)
  workflow_dispatch: {}    # 手動觸發(首次採用驗證 + ship-check 用)

permissions:
  contents: read

jobs:
  fresh-clone-rebuild:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 1 }

      # ---- 棧 setup(二選一)----
      # Cloudflare / Node:
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: npm }
      # Python:
      # - uses: actions/setup-python@v5
      #   with: { python-version: '3.12' }

      # ---- 不可重建檔案還原(secrets-archive / secrets)----
      # .env / .dev.vars 不進 git;CI 用 dummy 或從 secrets 還原夠跑 smoke 的子集。
      # [MUST] smoke 不得依賴真實 prod secret——用 fixture/dummy。
      - run: cp .env.example .env || true   # 若有 example;無則手動建最小 fixture

      # ---- 同一入口(manifest [bootstrap].script / [verify].script)----
      - run: ./scripts/bootstrap.sh
      - run: ./scripts/portability-smoke.sh

      # ---- 失敗上報 ----
      - if: failure()
        uses: rtCamp/action-slack-notify@v2
        env:
          SLACK_WEBHOOK: ${{ secrets.SLACK_WEBHOOK }}
          SLACK_MESSAGE: 'fresh-clone smoke 失敗 — 可重建性衰敗,見 09 §1.3'
```

## 消費者採用 checklist

- [ ] `.github/workflows/portability-smoke.yml` 就位,cron weekly。
- [ ] CI 呼叫 `./scripts/bootstrap.sh` + `./scripts/portability-smoke.sh`(§D:與 manifest 同入口)。
- [ ] smoke 不依賴真實 prod secret(用 fixture)。
- [ ] 失敗有通知(Slack / issue auto-create)。
- [ ] ship-check(02-BUILD-SPEC §4.1)前看到最近一次 weekly 綠。

## 跨棧注意

- **Cloudflare**:`bootstrap.sh` 內含 `npm run db:push --local`(local D1);CI 不碰 prod。`wrangler dev` smoke 跑 local。
- **Python**:`bootstrap.sh` 含 venv + `pip install -e .`;smoke 跑 `make test` + boot。
- **Node**:`bootstrap.sh` 含 `npm ci`;smoke 跑 `npm test` + boot。

## 與 09 §1.3 / §D guard 的關係

- §D(manifest-consumed)驗「manifest 入口指向存在且可執行的腳本」——本 CI job 驗「那些腳本真的能 fresh-clone 重建」。兩者互補:§D 是靜態存在性,CI 是動態可執行性。
- weekly 綠 = 09 §5 完成定義的「CI weekly fresh-clone rebuild job 已接且最近一次綠」。
