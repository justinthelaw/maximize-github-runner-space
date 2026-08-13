## Summary

Describe what changed and why.

## Validation

- [ ] `npm ci --ignore-scripts && npm test && npm run format:check && npm run check-dist`
- [ ] `pre-commit run --all-files --hook-stage pre-push`
- [ ] Representative runner smoke tests remain accurate
- [ ] README and docs updated for behavior changes

## Checklist

- [ ] Scope is focused and reviewable
- [ ] Destructive behavior impact reviewed
- [ ] Platform and architecture applicability reviewed against runner-images
- [ ] Group/skip overlap behavior reviewed
- [ ] Security impact considered
