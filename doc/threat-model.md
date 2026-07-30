# Threat model

This document defines the security boundary used when designing and reviewing PiCC. Its audience is
agents and contributors deciding whether a security concern is in scope and whether a proposed
defense is proportionate. It is not a catalogue of mechanisms or a hardening backlog.

## Baseline

PiCC adopts [Pi's security model](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md):
Pi runs with the permissions of the user who starts it, and files writable by that user are inside
the same local trust boundary. PiCC is not an operating-system sandbox. Users who need isolation
from code run by the agent must run the whole process in a container, virtual machine, or comparable
OS boundary.

The ambient environment chosen by the user is therefore trusted for PiCC's purposes. This includes
the user's home directory, `PATH`, shell, installed tools, and Git and npm configuration. A defense
against an attacker who already controls those surfaces does not protect a boundary PiCC claims to
enforce. Values originating in a project remain project input even when PiCC transports them through
an environment variable or stores them in a user-writable checkout.

## In scope

PiCC adds compatibility behavior around Pi, so it must preserve these boundaries and promises:

- **Enforced controls.** Project content and model-generated tool requests must not bypass the
  controls PiCC claims to enforce, including permission denies, agent tool gating, MCP approval, and
  worktree boundaries.
- **Untrusted project input.** A cloned project's settings, hooks, skills, agents, context files,
  MCP configuration, and path values may be malformed or hostile. Loading and parsing them must not
  silently grant capabilities or escape an advertised project or worktree boundary.
- **Command and path integrity.** When PiCC constructs commands or filesystem paths from untrusted
  input, that input must not become unintended command syntax or traverse beyond the boundary the
  operation promises.
- **Secrets handled by PiCC.** Authentication tokens, file contents, and other sensitive values must
  not be added unnecessarily to PiCC logs, transcripts, errors, or subagent prompts.
- **Remote MCP boundary.** Remote transport data is untrusted. PiCC confines configured static
  authentication material to the currently configured endpoint origin rather than forwarding it
  across cross-origin or secure-to-insecure redirects. PiCC-owned configuration, transport, status,
  diagnostic, and local-error surfaces do not expose secret-bearing URL/header values or raw
  non-protocol HTTP failure data; approved MCP metadata, results, and protocol-level tool errors
  remain untrusted server-controlled content visible to the model.

Model output and project content are untrusted inputs to those promises. They are not separate
operating-system principals: after the user authorizes an arbitrary command, that command has the
same host access as PiCC.

Starting PiCC in a project authorizes its documented Claude Code compatibility behavior, including
loading supported project resources and running declared command hooks. That declared execution is
not itself a permission bypass. Project input remains untrusted where PiCC parses it, constructs a
surrounding command or path from it, or applies an explicit gate to it.

## Out of scope

PiCC does not attempt to defend against:

- control of the user's account, home directory, environment, shell, `PATH`, or local executable
  lookup;
- the user's own Git, npm, proxy, certificate, registry, or ignore configuration;
- malicious tools, dependencies, extensions, or commands the user deliberately installs or runs;
- containment after the user grants a tool or command the authority needed to perform an action; or
- attackers who can replace PiCC, Pi, or a user-installed tool before launch.

An out-of-scope security story can still reveal a correctness, reliability, or usability bug. Review
that concrete user impact under the ordinary quality rules; do not use the security label to bypass
proportionality.
