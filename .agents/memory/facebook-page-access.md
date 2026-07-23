---
name: Facebook page access
description: How connected Facebook pages are discovered for campaign creative selection.
---

The page selector aggregates pages from every saved account token, but it cannot display pages that Facebook does not return from that token's `/me/accounts` permission scope.

**Why:** A user may have multiple ad accounts while their token can access only one Page; the UI cannot infer or manufacture missing Page permissions.

**How to apply:** When a Page is missing, verify the relevant token has Page access and the required Meta permissions, then refresh the campaign account selection.