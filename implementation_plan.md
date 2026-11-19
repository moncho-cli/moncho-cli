# deprecate the main task.md file from the repo, delete it, the task-backlog.md is a global file so that can stay, but now task.md should be specific to each session own path, as well as implementation-plan.md

status: done — every step verified

## Steps

- [x] Analyze current task.md/implementation_plan.md usage across the codebase
- [x] Modify session store to include task.md and implementation_plan.md content in session files
- [x] Update update_task tool to read/write session-specific task/plan files
- [x] Update work-drive and work-command to use session-specific task.md
- [x] Update constants.js to make TASK_FILE and PLAN_FILE dynamic per session
- [x] Ensure session restore loads task/plan from session data
- [x] Ensure session save writes current task/plan to session data
- [x] Delete the root task.md and implementation_plan.md files
- [x] Update tests to use session-specific task/plan files
- [x] Verify the changes work with a test session