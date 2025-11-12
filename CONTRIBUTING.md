# Contributing to Whisker

Thanks for your interest in improving Whisker! This document outlines how to propose changes and report issues so we can keep development fast, friendly, and predictable.

## Getting Started

1. **Fork and clone** the repository.
2. **Install dependencies** required for your change (for example Tailwind CLI if you are touching styles).
3. **Load the extension** in a Chromium browser with developer mode enabled to test manually.

## Branching Strategy

- Create a feature branch from `main` using a descriptive name such as `feature/mic-hotkey` or `fix/storage-error`.
- Keep branches focused; unrelated fixes should be submitted separately.

## Coding Guidelines

- Match existing code style and formatting. The JavaScript files use modern ES syntax and prefer descriptive helper functions.
- Add concise inline comments only when the intent of a block may not be obvious.
- Update or add tests or manual test notes when behavior changes.

## Commit Messages

- Use the imperative mood (e.g., `Add modal focus trap`).
- Reference relevant issues in the message body when applicable.

## Pull Requests

1. Describe the problem and your solution in the PR description.
2. Include before/after notes, screenshots, or screen recordings for UI changes.
3. List manual test steps taken (e.g., recording in different field types, handling denied microphone access).
4. Ensure the extension still builds and the CSS bundle is current if styles were touched.

## Reporting Issues

- Provide clear reproduction steps, expected vs. actual outcomes, and browser/version information.
- Attach logs or console output when possible.

## Security & Privacy

- Do **not** post sensitive keys or tokens in issues or PRs. Contact the maintainers privately for potential vulnerabilities (see `SECURITY.md`).

We appreciate every bug report, documentation improvement, and feature idea. Thank you for helping Whisker grow!
