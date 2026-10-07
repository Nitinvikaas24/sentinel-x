# Sample services

Two tiny services for demonstrating the "test your own service" flow.

| Zip | What it is | Expected result |
|---|---|---|
| `good-service.zip` | Replies immediately | Canary matches baseline, so **PASS** (with chaos `none`) |
| `slow-service.zip` | Same code plus a 150 ms delay per request | Canary slower than the healthy baseline, so **FAIL** |

Both are also bundled into the API (`dashboard/backend/samples/`) and can be
queued from the dashboard with one click. Rebuild the zips with
`py scripts/make_samples.py`.
