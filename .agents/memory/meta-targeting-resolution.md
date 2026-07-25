---
name: Meta targeting resolution
description: Rules for keeping Facebook flexible_spec targeting compatible with the selected ad account.
---

Targeting names must be resolved against the selected account token immediately before ad-set creation. Never forward a saved or AI-generated ID without an exact name/type match, and never substitute the first broad search result.

**Why:** Meta targeting IDs can become unavailable or map to a different targeting category; sending the wrong key causes the entire ad set to fail with a generic parameter error.

**How to apply:** Re-resolve interest, behavior, demographic, life-event, job-title, and location names for every create request. Drop unresolved items rather than guessing, and keep optional targeting metadata out of the request unless the account/API explicitly supports it.