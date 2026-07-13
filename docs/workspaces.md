# Workspace manifests and reports

Workspace mode is for one local control document that explicitly names several
first-party repositories and their declared deployments. It is not repository
auto-discovery: names, import edges, and nearby directories do not add a
repository or deployment.

## Manifest format

`workspace-manifest/v2` is JSON or JSONC. Descriptors are interpreted relative
to the manifest directory, but valid descriptors may contain leading parent
segments and can resolve outside that directory (for example, `../api`). The
manifest and its base inputs are therefore trusted local control data: review
them before scanning and do not treat a manifest-relative descriptor as a
containment guarantee. Resolved repository roots must still be existing
directories.

```jsonc
{
  "schemaVersion": "workspace-manifest/v2",
  "repositories": [
    { "id": "api", "root": "../api" },
    { "id": "worker", "root": "../worker" }
  ],
  "deployments": [
    {
      "id": "production",
      "repositories": ["api", "worker"],
      "inputs": {
        "bindings": "./production/bindings.json",
        "inventory": "./production/inventory.json",
        "closedModel": "./production/closed-model.json",
        "memberScopes": [
          {
            "repositoryId": "api",
            "scope": {
              "id": "api-runtime",
              "componentId": "api",
              "phase": "runtime",
              "stage": { "kind": "exact", "values": ["production"] },
              "channel": "environment"
            }
          },
          {
            "repositoryId": "worker",
            "scope": {
              "id": "worker-runtime",
              "componentId": "worker",
              "phase": "runtime",
              "stage": { "kind": "exact", "values": ["production"] },
              "channel": "environment"
            }
          }
        ]
      }
    }
  ]
}
```

The top-level object has exactly `schemaVersion`, `repositories`, and
`deployments`. Repository IDs and deployment IDs must be unique. A deployment
lists one or more declared repository IDs, without duplicates.

### Scan-only and provisioning deployments

Omit `inputs` for a scan-only deployment. When `inputs` is present:

- `bindings`, `inventory`, and `memberScopes` are required;
- `closedModel` is optional;
- `memberScopes` has exactly one entry for every declared deployment
  repository;
- each `repositoryId` is explicit, and its execution scope is separate from
  the repository ID; and
- scopes may not overlap within the deployment for the same execution unit,
  phase, channel, and stage coverage.

Supported member-scope phases are `runtime`, `build`, `test`, `dev`, and `ci`.
Supported channels are `environment`, `build-substitution`, `mounted-file`,
and `provider-sdk`. A stage is either `{ "kind": "all" }` or a nonempty list
of exact stage values. Unknown scopes are rejected instead of silently making a
provisioning claim.

Version 1 manifests remain parseable only for scan-only use. A v1 deployment
that includes `inputs` is rejected. Successful v1 scan-only input is normalized
to the v2 manifest/report behavior; migrate to v2 before adding bindings,
inventory, or a closed model.

## Local provisioning documents

Workspace provisioning documents are local JSON, not provider API responses.
They must be value-free. The parser accepts only the documented schema fields;
unknown or malformed input becomes scoped coverage uncertainty rather than
reporting raw input text.

### Binding manifest: `binding-manifest/v1`

A binding candidate maps one logical destination to an optional
provider-qualified resource in a declared execution scope. Precedence and
conditions are facts for selection; the tool does not execute a platform's
configuration language.

```json
{
  "schemaVersion": "binding-manifest/v1",
  "inputId": "production-bindings",
  "adapterId": "local-export",
  "candidates": [
    {
      "id": "api-runtime-payments-token",
      "adapterId": "local-export",
      "scope": {
        "id": "api-runtime",
        "componentId": "api",
        "phase": "runtime",
        "stage": { "kind": "exact", "values": ["production"] },
        "channel": "environment"
      },
      "destination": { "namespace": "env", "name": "PAYMENTS_API_TOKEN" },
      "sourceKind": "secret-manager",
      "providerResourceId": {
        "authorityId": "provider-production",
        "canonicalId": "payments-api-token"
      },
      "appliesWhen": {
        "executionUnitIds": ["api-runtime"],
        "phases": ["runtime"],
        "stage": { "kind": "exact", "values": ["production"] },
        "channels": ["environment"],
        "condition": { "kind": "always" }
      },
      "precedence": { "source": "deployment-env", "rank": 10, "comparable": true },
      "resolution": "exact"
    }
  ]
}
```

`resolution: "dynamic"`, an unknown selector, an incomparable precedence, or
a conflicting conditional selection is not exact-declared evidence. A binding
may use `sourceKind` `manifest`, `secret-manager`, or `external`; provider
resource identity is represented by both `authorityId` and `canonicalId` and
is never joined by a display name alone.

### Inventory snapshot: `inventory-snapshot/v1`

An inventory is a local, timestamped list of provider resources. Every item
belongs to the snapshot's `authorityId`. Optional `declaredScopes` constrains
where the item is asserted to belong.

```json
{
  "schemaVersion": "inventory-snapshot/v1",
  "inputId": "production-inventory",
  "authorityId": "provider-production",
  "asOf": "2026-01-01T00:00:00Z",
  "items": [
    {
      "providerResourceId": {
        "authorityId": "provider-production",
        "canonicalId": "payments-api-token"
      },
      "declaredScopes": [
        {
          "id": "api-runtime",
          "componentId": "api",
          "phase": "runtime",
          "stage": { "kind": "exact", "values": ["production"] },
          "channel": "environment"
        }
      ]
    }
  ]
}
```

An item is not considered delivered or authorized merely because it appears in
an inventory snapshot.

### Closed provisioning model: `closed-provisioning-model/v1`

A closed model is an explicit, stricter contract for a particular scope. It is
optional, and it must be paired with `--verification-base` for single-root
reconciliation. In workspace mode, the manifest-controlled local input base is
used by the workspace runtime.

Each model scope declares its scope, stages, approved first-party roots,
binding roots, expected input identities, permitted exclusions, inventory
authority mappings, external mechanisms, and its outside-root policy. The
following skeleton shows the required shape; populate it with safe logical
identifiers and value-free paths only.

```json
{
  "schemaVersion": "closed-provisioning-model/v1",
  "inputId": "production-model",
  "maxFiniteKeyDomain": 20,
  "scopes": [
    {
      "scope": {
        "id": "api-runtime",
        "componentId": "api",
        "phase": "runtime",
        "stage": { "kind": "exact", "values": ["production"] },
        "channel": "environment"
      },
      "declaredStages": ["production"],
      "closed": true,
      "approvedFirstPartyRoots": ["api"],
      "bindingRoots": ["production"],
      "expectedAdapterInputs": [
        { "inputId": "production-bindings", "domain": "binding", "adapterId": "local-export" },
        { "inputId": "production-inventory", "domain": "inventory" }
      ],
      "permittedExclusions": [],
      "inventoryAuthorities": [
        { "authorityId": "provider-production", "inventoryInputId": "production-inventory" }
      ],
      "allowedExternalMechanisms": [],
      "outsideRootImports": "out-of-scope"
    }
  ]
}
```

See [the evidence model](evidence-model.md#closed-provisioning-models) for the
conditions that keep an absence conclusion conservative.

## Workspace report format

`workspace scan --format json` produces
`secret-reference-inventory/workspace-report/v2`:

```text
workspace report
├── summary: repository/deployment counts and incomplete flag
├── repositories[]
│   └── id, state, diagnostics, optional single-repository report/v1
└── deployments[]
    └── id, repositoryIds, state, sharedKeys, diagnostics, members[]
        └── repositoryId, state, diagnostics, optional report/v1 partition
```

States are `complete`, `incomplete`, or `invalid`. A member partition is
repository-qualified: it is never a flattened or inferred cross-repository
mapping. A deployment with multiple repositories may show a key in `sharedKeys`
only when direct static demand for that logical key appears in at least two of
its explicit members. It says nothing about equal values, shared provider
resources, or runtime delivery.

Each embedded report has the single-repository schema
`secret-reference-inventory/report/v1`. Refer to
[Evidence and reconciliation model](evidence-model.md#report-interpretation)
for its groups, dynamic lookups, scope coverage, and result axes.

## Operational limits

Workspace parsing and execution are deliberately bounded. The manifest permits
up to 10,000 repositories, 10,000 deployments, 10,000 members in a deployment,
and 50,000 deployment-member declarations in total. A single workspace
invocation also bounds its report graph, local provisioning input bytes, and
input-cache entries. When a legal but oversized input cannot be fully
represented under those bounds, the affected repository or member is marked
incomplete rather than yielding a partial absence conclusion. See
[Privacy, boundaries, and limits](privacy-and-limits.md#resource-limits).
