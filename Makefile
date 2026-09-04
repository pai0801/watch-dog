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
ci: lint test
	python3 scripts/check-manifest-gitignore.py
	python3 scripts/check-secrets-coverage.py
	@echo "CI passed ✅"

smoke:
	bash scripts/portability-smoke.sh

clean:
	rm -rf node_modules .wrangler dist
	@echo "cleaned"
