# Contributing to AccessGuard

Thanks for contributing to AccessGuard! This document outlines how our team works together on this project.

## Branching Strategy

- `main` — stable, working code only. Do not commit directly to `main`.
- Create a feature branch for your work, named after what you're building, e.g.:
  - `feature/webcam-monitoring`
  - `fix/heartbeat-timeout`
  - `docs/readme-update`

## Workflow

1. Pull the latest changes from `main` before starting new work:
   ```bash
   git checkout main
   git pull
   ```
2. Create a new branch for your task:
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. Make your changes and commit them in small, logical chunks (see commit message guidelines below).
4. Push your branch and open a pull request into `main`:
   ```bash
   git push -u origin feature/your-feature-name
   ```
5. Request a review from at least one other team member before merging.

## Commit Message Guidelines

Write clear, descriptive commit messages that explain *what* changed and *why*, not just *that* something changed.

**Good:**
```
Add heartbeat timeout handling to client connection logic
Fix whitelist not updating after policy change
Add future enhancements section to README
```

**Avoid:**
```
update
fix stuff
changes
```

Use the imperative mood ("Add X" not "Added X" or "Adds X") to match standard Git conventions.

## Code Style

- Follow existing naming conventions in the codebase (PascalCase for C# classes/methods, camelCase for local variables).
- Keep functions focused — if a method is doing too much, consider splitting it.
- Comment non-obvious logic, especially around network communication, policy enforcement, and process monitoring, since these are security-sensitive areas.

## Reporting Issues

If you find a bug or have a feature request, open an issue describing:
- What you expected to happen
- What actually happened
- Steps to reproduce (if applicable)

## Questions

If you're unsure about scope, architecture decisions, or anything in the project proposal, check with the team before making major changes.
