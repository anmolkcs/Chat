# Vendored libraries

Served from this repo (no third-party scripts at runtime, so the CSP can be `script-src 'self'`).
Copied unmodified from jsDelivr; SHA-384 of each file at the time it was added:

| File | Package | SHA-384 (base64) |
|------|---------|------------------|
| marked.min.js | marked@15.0.12 (MIT) | 948ahk4ZmxYVYOc+rxN1H2gM1EJ2Duhp7uHtZ4WSLkV4Vtx5MUqnV+l7u9B+jFv+ |
| purify.min.js | dompurify@3.4.17 (Apache-2.0 / MPL-2.0) | P0JNneQf81HOl9VwNXK76cQ9VMD6Nfsnepxb0cCOg8+UzEdzgPHAPV4wVQrvYQSx |
| highlight.min.js | @highlightjs/cdn-assets@11.12.0 (BSD-3-Clause) | wjfDDhOPPdjtva8vWBhWeVprSpmxisEu5aYT3q1JyACqXpdKpo3PWZTMVq24MBix |

To update: download the new file from `https://cdn.jsdelivr.net/npm/<package>@<version>/...`, check it, replace it here, update this table.
