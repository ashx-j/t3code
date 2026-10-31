---
name: release-notes
description: Drafts release notes from the commits since the last tag.
---

List the commits since the last tag with `git log $(git describe --tags --abbrev=0)..HEAD`, group
them by feature, fix and chore, and write one past-tense line per change.
