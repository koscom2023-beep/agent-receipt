# License model

**Core (this repository): MIT, permanently.**
The CLI, receipt generation, local verification (`verify-proof`), the receipt
format and spec, and the evidence kernel are MIT licensed and will stay MIT.
An audit tool has to be open to be trusted, so we will not relicense the core.

**Commercial add-ons (future, separate packages): source-available (BSL/FSL).**
Optional hosted or organization-scale components (an organization dashboard, a
hosted independent transparency log, SSO/SAML, organization-level policy
enforcement, compliance export, a hosted verification service) will ship as
separate packages under a source-available license. They are not part of this
MIT core, and this core never depends on them to function.

This split keeps the trust engine open while funding the work.
