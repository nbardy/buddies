# Walkthrough: show the owner the app

The owner decides whether this app is right by reading your walkthrough. He runs a repair
workshop and will not read code. Show him every screen, in the order he would use it.

## Do

1. Build and start the app from your commit with a fresh database and the seeded staff user.
2. Work through this story, entering realistic workshop data: sign in; add a customer; add a
   vehicle for that customer; book a job on the vehicle and move it through its statuses; raise
   an invoice for the job, add line items, mark it sent and then paid. Then: search each list;
   edit one record of each kind; try to delete the customer and show the refusal; delete from
   the bottom of the chain upward; sign out and show that a signed-out visitor sees nothing.
3. Take a screenshot at every step, of the real running app. Save each as WebP under
   `docs/walkthrough/shots/`, numbered in story order.
4. Write `docs/walkthrough/README.md`: for each step, one or two plain sentences on what the
   owner is looking at, then the screenshot. Start with a table of the four features and whether
   each of list, search, view, create, edit and delete works.

## Honesty

- If a step fails or looks wrong, screenshot it as it is and say so at that step. Do not fix
  the app; you may change only `docs/walkthrough/`.
- Never reuse a screenshot for two steps, crop out an error, or describe something the
  screenshot does not show. A reviewer on another model compares every sentence with its image.
- Do not describe the code, the stack or how it was built.

## Stop

When every step of the story has its screenshot and sentence. Commit. In your report, give the
count of steps that worked and list those that did not.
