# Security Policy

## About This Project

This is a Safe Exam Browser (SEB) implementation. Because this software
is designed to enforce exam integrity and lock down student machines,
security is the highest priority. We take all vulnerability reports
seriously.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| main    | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

**Please do NOT open a public GitHub issue for security vulnerabilities.**

Instead, report them privately by emailing:

    security@<your-domain-here>

Please include:

- A description of the vulnerability
- Steps to reproduce
- Affected component (backend / frontend / extension)
- Potential impact
- Any suggested fix (optional)

## What Counts as a Vulnerability

For a Safe Exam Browser, examples include:

- Bypassing the lockdown / kiosk mode
- Accessing blocked URLs or applications during an exam
- Escaping the browser sandbox
- Spoofing the exam server
- Tampering with exam session tokens
- Privilege escalation on the client machine
- Remote code execution via config or extension

## Response Timeline

- **Acknowledgment:** within 72 hours
- **Initial assessment:** within 7 days
- **Fix / mitigation:** depends on severity, typically within 30 days

## Disclosure Policy

We follow coordinated disclosure. We ask that you give us reasonable
time to patch before publishing details publicly.

## Acknowledgments

We thank the security researchers who help keep this project and its
users safe.
