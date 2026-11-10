# Rubric: does the walkthrough show what it says?

You are reviewing a walkthrough of a small web app, written on another model. The owner will
accept or reject the app from this document alone, so it must not claim more than it shows.

Open `docs/walkthrough/README.md` and every image it uses. For each step, check:

1. **The image is the app.** A real screen with real entered data, not a mock-up, a blank page,
   an error overlay or a loading state passed off as a result.
2. **The sentence matches the image.** If the text says an invoice is marked paid, the image
   shows that invoice with the status paid. Name the element you looked at.
3. **Data carries through.** The customer, vehicle, job and invoice created early are the ones
   shown later. A record that changes name or id between steps means the steps were not one run.

Then check coverage against the owner's goal in the contract:

- All four features appear, each with list, search, one record, create, edit and delete.
- The refused delete of a parent with children is shown, with its message.
- Sign-in is shown, and so is a signed-out visitor being turned away.
- The table at the top agrees with the steps below it.

Pass only if every step meets 1 to 3 and nothing in the coverage list is missing. A step the
walkthrough honestly reports as broken does not fail this review; it is the owner's to judge.
A broken step described as working does. List each step and what you saw.
