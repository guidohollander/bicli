# CAP-0003 Repository Version Survey

This note records the generic version-survey approach for Be Informed repositories without embedding customer-specific results.

## Scope

Included:

- non-frontend Be Informed repositories under the configured repository root
- sampled `.bixml` plugin-version declarations
- representative architecture sampling across multiple repositories

Excluded:

- frontend-only repositories
- helper repositories with no meaningful `.bixml` content

## Dominant Version Families

In practice, Be Informed repository sets often cluster around a small number of dominant version families, with occasional older or newer patch-level remnants.

The important design implication for `bicli` is not the exact customer-specific distribution, but that:

- one repository usually has one dominant version profile
- mixed-version remnants can still exist at project or artifact level
- repository modeling should preserve both the dominant profile and local version hints

## Structural Conclusion

Across repositories, the project structure is often stable enough to infer:

- shared library or shared core
- interface-definition projects
- domain core projects
- project-specific layers
- optional DSC core and DSC specific layers
- interaction or portal composition layers
- `_CONTINUOUS_DELIVERY` studio packaging

## Operational Implication

For `bicli`, version-aware repository understanding should be implemented as:

- one repository model per repo
- one dominant version profile per repo
- multiple version hints per project and artifact where mixed-version remnants exist
- shared cross-version project-role and artifact-kind inference

This is the basis for:

- repository-level validation
- artifact tracing for debugging
- target-project selection for bounded creation
- mixed-version drift detection during maintenance
