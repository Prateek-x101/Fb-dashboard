---
name: Meta campaign budget flag
description: Required campaign budget-sharing behavior for current Meta Marketing API accounts.
---

Meta may reject campaign creation when `is_adset_budget_sharing_enabled` is omitted. Campaign creation must send an explicit boolean, and ad-set budget sharing must be disabled when using a campaign-level budget.

**Why:** Newer ad accounts enforce an explicit choice between campaign budget and ad-set budget sharing. Meta rejects the combination of campaign-level budget plus enabled ad-set budget sharing.

**How to apply:** Send `is_adset_budget_sharing_enabled: false` for this app’s CBO/ABO flows, keep campaign-level and ad-set-level budgets mutually exclusive, and explicitly use `LOWEST_COST_WITHOUT_CAP` on each ad set unless a different strategy and its required bid controls are intentionally configured.

Meta error subcode `1815857` means the selected bid strategy requires a bid amount. `LOWEST_COST_WITHOUT_CAP` is the safe default because it does not require `bid_amount`; strategies such as bid cap and cost cap do.