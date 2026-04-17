# CAP-0003 Repository Version Survey

This note records the current repository survey under `C:\repo` using the local `bimcp` server and the sampled `list_repository_versions` tool output.

## Scope

Included:

- non-frontend Be Informed repositories under `C:\repo`
- sampled `.bixml` plugin-version declarations
- representative architecture deep-dives in `gd_mts` and `bes_bbf`

Excluded:

- frontend-only repositories such as `*-frontend`
- non-Be Informed helper or export repositories with no sampled `.bixml` content

## Dominant Version Families

The current repo set clusters into these practical version profiles:

- `23.2.6.202501081215`
  Dominant across `aia_mbs`, `aia_mbs-demo`, `aia_mts`, `gd_mbs`, `gd_mts`, `png_mts`, `revert`, `servicecatalog`, `vct_mts`, and parts of `skn_mts`, `gd_opo`, `gd_mts-pfix`.
- `23.2.5.202412131027`
  Transitional profile visible in `gd_mts-pfix` and `skn_mts`.
- `23.2.9.202510140827`
  Later 23.2 profile visible in selected artifacts in `gd_mts` and `gd_opo`.
- `24.2.6.202511211123`
  Dominant 24.2 profile in `bes_bbf`.

Observed secondary compatibility markers:

- `23.2.2.1`
- `23.2.2.2`
- `23.2.2.4`
- `23.2.3.202407161414`
- `24.2.2.1`
- `24.2.2.4`

## Structural Conclusion

The version spread is narrow enough that `bicli` should operate with:

- a dominant `23.2.6` baseline profile
- a dominant `24.2.6` baseline profile
- compatibility refinements for older and newer patch-level variants

The representative architecture deep-dives confirm that the repo structure is largely stable across these families:

- shared library or shared core
- interface-definition projects
- domain core projects
- specific projects
- DSC core and DSC specific layers where applicable
- interaction or portal composition layers
- `_CONTINUOUS_DELIVERY` studio packaging

## Operational Implication

For `bicli` and `bimcp`, version-aware repository understanding should be implemented as:

- one repository model per repo
- one dominant version profile per repo
- multiple version hints per project and artifact where mixed-version remnants exist
- shared cross-version project-role and artifact-kind inference

This is the basis for:

- repository-level validation
- artifact tracing for debugging
- target-project selection for creation
- mixed-version drift detection during maintenance
