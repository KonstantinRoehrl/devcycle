# Lessons

## branch-review
- Before flagging a finding, confirm it's live in this diff, not a sibling's stale checkout artifact [friction:reviewer-role-confusion]
- Check diff size before a branch review -- chunk or use `rtk proxy git diff`, don't trust one truncated pass [novel:branch-review-diff-truncation-hides-findings]

## execution
- Never `git stash` on a checkout a sibling task may share -- use `git diff` to scratch instead [novel:git-stash-on-shared-concurrent-checkout]
- Wave briefs must name sibling-safety/re-staging steps -- shared checkouts let tasks' git state bleed [novel:shared-checkout-cross-task-git-state-bleed]
- Write golden-path assertions to survive prose reflow, not as literal line-anchored regexes [novel:golden-path-prose-regex-fragile-to-reflow]

## planning
- Leave headroom below a line-ceiling budget; don't ratchet plans to an exact-fit measurement before all tasks land [novel:surface-line-budget-arithmetic-gap]
- Check a dispatch brief's Files block covers everything its steps touch, including decision logs and config notes [friction:incomplete-dispatch-brief]

## scoping
- Harden /devcycle:continue's resume checklist -- state-file/resume-context recognition has repeatedly missed [novel:continue-state-file-discovery-failure]
