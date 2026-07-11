---
paths:
  - "src/**/*.rs"
---

# Rust rules (path-scoped — inject only when touching src/**/*.rs)

Canary: FS-RULE-RUST-PATHSCOPED

- Never use `unwrap()` in library code.
