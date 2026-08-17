# Secret 依賴清單 — watch-dog

> ⚑ **骨架(自動生成 2026-08-17)**:名稱取自 `.portability.toml [secrets]`;敘述欄標 ⚑ TODO(人工)待補。
> 補齊準則見 `~/Code/rules/references/SECRETS-CONTRACT-TEMPLATE.md` 與 10-SECRETS-CONTRACT §2。
> 人類合約:這份表告訴你「動了會死在哪裡」。機讀後設資料在 `.portability.toml [secrets.meta]`;敘述性欄位只在這裡,不雙寫。
> rotate 後:設新值到雲端(`wrangler secret put <NAME>` / dashboard)→ redeploy → `bash secrets-archive/seal.sh` → 更新本表「上次更換」→ git commit。

| Secret 名稱 | 用途(一句話) | 來源(服務/帳號) | 被誰使用(檔案/服務) | 換掉的影響範圍 | 上次更換 |
|---|---|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | ⚑ TODO(人工) | ⚑ TODO(人工) | ⚑ TODO(人工) | ⚑ TODO(人工) | — |
