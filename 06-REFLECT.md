# 06-REFLECT.md — Agent Self-Audit Protocol

> 強制類別（guard/artifact/human）見 `ENFORCEMENT_REGISTRY.md`，由 D18 meta-guard 驗證。

## 0 — Purpose

This document defines a self-reflection protocol for AI agents working under the engineering framework (01–05). Unlike other phases that audit code, documentation, or security, this phase audits the **agent's own process compliance** — did you follow the rules you were given?

[MUST] Run this protocol at every trigger point listed in Section 1.
[NEVER] skip reflection because "the task was small" or "I was careful."

> **Reflection 為 artifact**：每個觸發點 [MUST] 產出一份 reflection 寫入 `REFLECT.md`，
> 模板見 `references/REFLECT-TEMPLATE.md`。由 **D20 guard** 驗證：本 cycle/session 有 REFLECT.md，
> R1–R5 各段非空、無裸 `N/A` 逃避。未產 REFLECT → D20 fail。

---

## 1 — Trigger Points

[MUST] Run reflection at these moments:

| Trigger | Scope (Section) | Time Budget |
|---------|-----------------|-------------|
| End of session | Quick Check (Section 3) | ≤ 2 min |
| Before `git commit` | Full Audit (Section 4) | ≤ 5 min |
| After multi-step task | Full Audit | ≤ 5 min |
| Phase transition (e.g., build → harden) | Phase-Specific Check | ≤ 3 min |
| User explicitly requests | Full Audit | No limit |

[NEVER] batch reflections. Each trigger runs its own check.

---

## 2 — [MUST] Experience Search (getkm)

Before reflecting, [MUST] call `getkm` to surface past self-audit findings from this and other projects:

```
getkm("agent self-audit compliance reflection", tags=["self-audit", "process-compliance"])
```

If results show **recurring violations** in this project, [MUST] pay extra attention to those areas in this session's audit.

---

## 3 — Quick Check (End-of-Session)

[MUST] answer these 5 questions honestly. Write answers as a self-audit note.

### R1: [MUST] Directives

Did I violate any `[MUST]` directive from 01–05?
- [ ] Yes → list each violation and why
- [ ] No → proceed

### R2: [NEVER] Directives

Did I violate any `[NEVER]` directive from 01–05?
- [ ] Yes → **STOP.** This is a critical failure. Document and fix immediately.
- [ ] No → proceed

### R3: Process Flow

Did I follow the correct phase sequence?
- Build: getkm → THINK → implement → verify → putkm
- Fix: goal → getkm → THINK → fix → verify → putkm
- Hardening: getkm → D1–D12 → guards → putkm

- [ ] Skipped steps → list which and why
- [ ] All steps followed

### R4: Verification

Did I actually verify my changes (not just "looks good")?
- [ ] Verified with tests / manual check / build
- [ ] Skipped verification → why?

### R5: Experience Recording

Did I call `putkm` for non-trivial learnings?
- [ ] Recorded
- [ ] Skipped → record now if the session had learnings

[MUST] pass all 5 checks before ending a session.
[MUST] fix any CRITICAL or HIGH issue found before closing.

### R6: [MUST] Retro block（D30）

cycle/session-end [MUST] 產出 retro（完整模板見 `references/RETRO-PRE-MORTEM-TEMPLATES.md`）：

- [MUST] 選一格式：Start/Stop/Continue **或** 4Ls **或** Sailboat（不可混用）
- [MUST] 把 raw feedback 歸入 themes，標 sentiment
- [MUST] ≤3 個 prioritized action items（超過 3 個做不完），每個 specific + assignable（owner）+ measurable（success metric）+ deadline
- [MUST] 引用前次 retro 的 action items 狀態（done / carry / dropped）

> 由 **D30 guard** 驗證（augments D20）：retro block 存在，≥1 action item 含 owner + deadline。未產 retro → D30 fail。

---

## 4 — Full Audit (Pre-Commit / Post-Task)

[MUST] run Full Audit before every commit and after every multi-step task.

### F1: Constitution Compliance (01-CLAUDE.md)

| Area | Check | Result |
|------|-------|--------|
| Tech stack | Used only approved technologies? | ✅ / ❌ |
| Architecture | Respected architectural boundaries? | ✅ / ❌ |
| Prohibitions | Avoided all `[NEVER]` items? | ✅ / ❌ |
| Project-specific | Filled in `[PROJECT_SPECIFIC]` values? | ✅ / ❌ / N/A |

### F2: Build Process (02-BUILD-SPEC.md)

| Area | Check | Result |
|------|-------|--------|
| getkm | Called before THINK block? | ✅ / ❌ |
| THINK | All 7 fields populated? | ✅ / ❌ |
| Implementation | Followed the planned approach? | ✅ / ❌ |
| Self-review | Reviewed before claiming done? | ✅ / ❌ |
| putkm | Recorded non-trivial learnings? | ✅ / ❌ / N/A |

### F3: Documentation Review (03-DOC-AND-CODE-REVIEW.md)

| Area | Check | Result |
|------|-------|--------|
| Accuracy | Documentation matches current code? | ✅ / ❌ |
| Completeness | No undocumented modules/endpoints? | ✅ / ❌ |
| TODO-REVIEW | Created for discovered issues? | ✅ / ❌ / N/A |

### F4: Hardening (04-HARDENING_PROTOCOL.md)

| Area | Check | Result |
|------|-------|--------|
| getkm (Step 0) | Searched cross-project defense patterns? | ✅ / ❌ / N/A |
| D1–D12 | Ran all applicable defense checks? | ✅ / ❌ |
| Budgets | Budgets (as-any, raw SQL, etc.) only decreased? | ✅ / ❌ / N/A |
| putkm | Recorded new defense patterns? | ✅ / ❌ / N/A |

### F5: Fix Process (05-FIX-SPEC.md)

| Area | Check | Result |
|------|-------|--------|
| Goal | Recorded fix goal before starting? | ✅ / ❌ / N/A |
| getkm | Searched for similar past bugs? | ✅ / ❌ / N/A |
| Verification | Fix verified (not just "compiles")? | ✅ / ❌ / N/A |
| putkm | Recorded bug + solution? | ✅ / ❌ / N/A |

### F6: [MUST] Retro (D30)

| Area | Check | Result |
|------|-------|--------|
| Format | Start/Stop/Continue or 4Ls or Sailboat chosen? | ✅ / ❌ |
| Action items | ≤3 items, each specific + owner + deadline + metric? | ✅ / ❌ |
| Carry-over | Prior retro action items status tracked? | ✅ / ❌ / N/A |

---

## 5 — [MUST] Corrective Action Protocol

When violations are found, [MUST] classify severity:

| Severity | Criteria | Action |
|----------|----------|--------|
| CRITICAL | `[NEVER]` violation, security issue, data loss risk | Fix immediately, before any other work |
| HIGH | `[MUST]` directive skipped, process not followed | Fix in current session |
| MEDIUM | Incomplete documentation, missing putkm | Create TODO, fix within next session |
| LOW | Style inconsistency, minor improvement | Note for next relevant session |

[NEVER] leave a CRITICAL or HIGH violation unaddressed.
[NEVER] proceed to commit with CRITICAL violations.

### Action Template

For each violation, record:

```
Violation: [directive violated]
Phase: [01/02/03/04/05]
Severity: [CRITICAL/HIGH/MEDIUM/LOW]
Root Cause: [why did it happen?]
Fix: [what will you do?]
Status: [FIXED / TODO / DEFERRED with reason]
```

[MUST] use this template for every violation found.
[NEVER] write vague descriptions like "will try harder."

---

## 6 — Audit Report Format

After Full Audit, produce a short report:

```markdown
## Self-Audit Report — [DATE]

Session scope: [what was worked on]
Phases active: [01/02/03/04/05]

### Compliance Summary
- R1 [MUST] directives: N violations
- R2 [NEVER] directives: N violations
- R3 Process flow: COMPLETE / SKIPPED STEPS
- R4 Verification: VERIFIED / UNVERIFIED
- R5 Experience recording: RECORDED / SKIPPED
- R6 Retro (D30): PRODUCED / MISSING

### Violations
[List violations with severity and action]

### Improvement Actions
[Specific actions to prevent recurrence]

### Retro (D30)
Format: [Start/Stop/Continue | 4Ls | Sailboat]
[Themes + sentiment]
Action Items (≤3):
1. [AI-1] <action> | owner | deadline | metric | carry-from
2. ...
Carry-over from prior retro: [status]
```

[MUST] save this report if violations were found.
[MUST] share recurring violations with the user — they may indicate framework rules that need updating.
[NEVER] delete past audit reports. They track process improvement over time.

---

## 7 — [MUST] Cross-Project Learning (putkm)

After completing a Full Audit with findings, [MUST] record to dev-brain:

```
putkm(
  problem="[description of process violation or gap]",
  solution="[corrective action taken]",
  tags=["self-audit", "process-compliance", ...],
  context="06-REFLECT [SEVERITY]"
)
```

[ALWAYS] record audit findings — they help future sessions avoid the same mistakes.
[NEVER] treat repeated violations as normal. If the same violation appears **3+ times**, escalate to user — the rule itself may need revision.

---

## 8 — Anti-Patterns

[NEVER] rubber-stamp the checklist without honest evaluation.
[NEVER] use "I was careful" as a substitute for verification evidence.
[NEVER] skip getkm/putkm because "this task is simple."
[NEVER] classify a `[NEVER]` violation as MEDIUM or LOW — it is always CRITICAL.
[NEVER] defer CRITICAL violations — fix them now.
[MUST] treat this protocol as seriously as the hardening protocol. Process compliance IS security.
