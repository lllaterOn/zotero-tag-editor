# Security

The latest stable release receives security fixes. Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/lllaterOn/zotero-tag-editor/security/advisories/new). Do not publish unpatched exploit details, credentials, private Zotero data, database copies, profile paths or library exports in public issues.

The plugin edits local Zotero metadata. Runtime code must not transmit item titles, tags, library identifiers, attachment paths, preferences or usage data to network services. Updates use the public HTTPS update manifest and immutable GitHub Release assets; URLs must never contain credentials.

Repository and package checks reject common credential patterns and machine-specific paths. If a credential is exposed, revoke or rotate it rather than merely deleting it from the latest revision.
