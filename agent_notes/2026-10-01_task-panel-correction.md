# Task panel correction

Owner rejected the vague Details & settings disclosure: the restyle had hidden the old form instead of making its purpose clear.

Removed that disclosure and the three-line description clamp. Full completion criteria render as markdown directly in the task page, along with next action, blocker and evidence when present. Edit task opens a labelled progress form immediately below the section heading, before the description, so a long description does not bury the editor. The form keeps the existing revision-checked PATCH write path and now uses a responsive layout instead of the old Work form style. Execution history has its own section after discussion.

Validation: 15 focused task/Work/mobile/comment tests passed; client solution and test typechecks and all nine invariant gates passed. Render regression checks assert visible criteria, explicit editing action, no settings disclosure, and history below discussion. Desktop and phone reading/editing screenshots use the owner's actual task, through the repository read-only CDP helper. Artifacts: output/screenshots/task-visible-details-2026-10-01. No application writes or push.
