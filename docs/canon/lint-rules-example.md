# Lint Rules Example

`bicli lint` accepts a markdown file and reads fenced `yaml` or `yml` blocks as lint-rule definitions.

Example:

```yaml
id: prefer-shared-attributes
kind: duplicate_inline_attribute
severity: warning
minOccurrences: 2
targetFolder: Behavior/_Case/Data/Attribute groups/Attributes
message: Inline attribute '{functionalId}' appears {count} times in project '{project}'. Consider extracting it to {targetFolder}.
```

```yaml
id: no-inline-interface-attributes
kind: inline_attribute_presence
severity: error
projectRoles: [interface]
message: Inline attribute '{functionalId}' appears in interface project '{project}'. Use a shared attribute-group artifact instead.
```

Supported rule kinds in the current first slice:

- `duplicate_inline_attribute`
  - groups identical inline attribute definitions per project and reports repeated occurrences
- `inline_attribute_presence`
  - reports any inline attribute occurrence, optionally limited to selected project roles

Supported keys:

- `id`
- `kind`
- `severity`
- `minOccurrences`
- `projectRoles`
- `message`
- `targetFolder`
