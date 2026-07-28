# TODO-REVIEW.md Template

**Project**: [PROJECT_NAME]
**Review Date**: YYYY-MM-DD
**Reviewer**: AI Agent

---

## Critical (Blocks Release)

| ID | Type | Location | Description | Evidence | Recommendation | Status |
|----|------|----------|-------------|----------|----------------|--------|
| TR-001 | BUG | `/api/shops/[slug]` | Direct DB error exposure | `res.status(500).send(error)` | Add error sanitization layer | Pending |
| TR-002 | SECURITY | `src/components/ReviewCard.jsx` | XSS: unsafe `dangerouslySetInnerHTML` | Unescaped tags | Implement input validation | Pending |

---

## High Priority (Recurring Errors)

| ID | Type | Location | Description | Evidence | Recommendation | Status |
|----|------|----------|-------------|----------|----------------|--------|
| HR-001 | HARDEN | Multiple files | Hardcoded Chinese (5 places) | `服務品質`, `聯絡我們` | Use t() function | Pending |
| HR-002 | TECH_DEBT | `src/lib/db/queries.ts` | Duplicate tenant isolation logic | Repeated WHERE conditions | Extract shared helper | In Progress |
| HR-003 | MISSING_TEST | `src/services/anomalyService.ts` | No unit tests | New feature uncovered | Add test coverage | Pending |

---

## Medium Priority (Doc Gaps)

| ID | Type | Location | Description | Evidence | Recommendation | Status |
|----|------|----------|-------------|----------|----------------|--------|
| MD-001 | MISSING_DOC | `src/lib/ai/generator.ts` | New feature undocumented | AI content generator | Update API docs | Pending |
| MD-002 | TECH_DEBT | `CLAUDE.md` | Outdated rule | Old Node.js version constraint | Update version requirement | Resolved |
| MD-003 | MISSING_TEST | API route tests | 3 endpoints lack tests | POST/PUT/PATCH endpoints | Add integration tests | Pending |

---

## Architecture Snapshot Changes

### Added Modules
- `src/services/anomalyService.ts` — Anomaly detection service
- `src/lib/ai/generator.ts` — AI content generation (refactored)

### Changed Modules
- `src/services/r2ShopService.ts` — Added cross-locale consistency logic
- `src/lib/runtime.ts` — Added OPENAI_BASE_URL support

### Removed Modules
- ~~`src/lib/legacy-logger.ts`~~ — Deleted

### Data Flow Changes
- Added: Anomaly detection -> R2 data tagging flow
- Changed: Shop data update -> analytics sync flow

---

## Hardening Suggestions

### ESLint Rule Candidates
```javascript
// Suggested rule: [NEVER] API error leak
{
  rules: {
    'local/no-error-leak': 'error'
  }
}
```

### Architecture Guard Candidates
```typescript
// Suggested test: API error sanitization check
test('API errors must be sanitized', () => {
  expect(errorResponses).not.toContain(dbErrors);
});
```

---

## Statistics

- Total items: 15
  - Critical: 2
  - High: 3
  - Medium: 6
  - Architecture: 4
- Resolved from last review: 8
- Recurring error patterns: 2 (need hardening)
