## Summary

Describe what changed and why.

## Validation

- [ ] `pre-commit run --all-files --hook-stage pre-push`
- [ ] `npm ci && npm test && npm run check-dist`
- [ ] Representative runner smoke tests remain accurate
- [ ] README and docs updated for behavior changes

## Checklist

- [ ] Scope is focused and reviewable
- [ ] Destructive behavior impact reviewed
- [ ] Platform and architecture applicability reviewed against runner-images
- [ ] Group/skip overlap behavior reviewed
- [ ] Security impact considered
