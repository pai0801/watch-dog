.PHONY: install lint build test test-app test-guards ci clean smoke

install:
	npm install

lint:
	npm run typecheck
	npm run lint

build:
	WRANGLER_SEND_METRICS=false npx wrangler deploy --dry-run --outdir dist

test:
	npm test

test-app:
	npm run test:app

test-guards:
	npm run test:guards

# CI 全量 gate（GitHub Actions self-hosted workflow + pre-push hook 同組合，09 §1.3）。
# §L/§M 需 tomllib（py≥3.11）；系統 python3 可能更舊——挑可用的。
PY ?= $(shell python3 -c 'import tomllib' 2>/dev/null && echo python3 || echo python3.12)

ci: lint test
	$(PY) scripts/check-manifest-gitignore.py
	$(PY) scripts/check-secrets-coverage.py
	@echo "CI passed ✅"

smoke:
	bash scripts/portability-smoke.sh

clean:
	rm -rf node_modules .wrangler dist
	@echo "cleaned"
