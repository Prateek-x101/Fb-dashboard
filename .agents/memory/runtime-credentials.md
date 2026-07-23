---
name: Runtime credentials
description: The project’s rule for storing Facebook, Gemini, and other runtime credentials.
---

Credentials and account access tokens must stay in the ignored local runtime storage and must never be committed in project configuration.

**Why:** The imported project contained live-looking Facebook and Gemini values in tracked storage, which exposed secrets and blocked completion review.

**How to apply:** Keep only an empty, credential-free example config in version control. Use the in-app Settings and Accounts flows to populate the ignored runtime file.