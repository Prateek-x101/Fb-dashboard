---
name: Meta campaign budget flag
description: Required campaign budget-sharing behavior for current Meta Marketing API accounts.
---

Meta may reject campaign creation with code 100/subcode 2446375 when `is_adset_budget_sharing_enabled` is omitted. Campaign creation must send an explicit boolean: enabled when using campaign-level budget, disabled when budgets are assigned to ad sets.

**Why:** Newer ad accounts enforce an explicit choice between Advantage/Campaign Budget and ad-set budgets, even when the API docs previously allowed the field to be implicit.

**How to apply:** Keep campaign-level and ad-set-level budgets mutually exclusive, and send the sharing flag on every campaign-create request.