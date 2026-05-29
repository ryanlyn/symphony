---
tracker:
  kind: slack
  channels:
    - C0123456789
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled
  emoji_states:
    rocket: Shipped
---

Slack workflow fixture (test only). Requires SLACK_BOT_TOKEN in the environment.
