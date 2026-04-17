# Security Policy

## Public-Safe Repository Rule

This repository is public. Do not commit:

- real customer repository names
- customer names
- customer-specific project names
- local user profile paths
- local machine-specific paths that reveal user identity
- repository analyses derived from non-public Be Informed repositories
- question/answer transcripts based on non-public repositories
- secrets, API keys, tokens, or credentials

Use generic placeholders instead, for example:

- `sample_beinformed_repo`
- `SC Sample`
- `C:\Users\<your-user>\...`
- `C:\path\to\bicli\...`

## Sensitive Documentation

Before pushing documentation changes, check that:

1. example repository names are generic
2. example paths use placeholders
3. no customer-specific business content remains in examples
4. screenshots, logs, and transcripts do not expose repository contents

## Reporting

If you discover sensitive or accidental customer-specific data in this repository, remove it promptly and rotate any exposed credentials immediately if secrets were involved.
