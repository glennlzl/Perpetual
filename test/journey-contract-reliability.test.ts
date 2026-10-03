import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBrowserCases, assertReviewedJourneys } from '../src/business/browser-cases.ts';
import { validateJourneySpec } from '../src/journeys/playwright/specs.ts';

const caseWith = (value: string) => validateBrowserCases([{
  id: 'save', name: 'Save and reopen a note', goal: 'Create a note and verify its saved contents after reopening.',
  steps: [{ id: 'save', title: 'Save and reload the new note', checks: [{ type: 'text-visible', value }] },
    { id: 'reopen', title: 'Reopen the saved note' }],
  expectedOutcomes: ['The note retains its saved contents.'], assertions: [], needsReview: false,
}])[0];
const code = (actions: string) => `import { test } from 'perpetual';
test('Save and reopen', async ({ page, journey }) => {
  await journey.milestone('save', async () => { ${actions} });
  await journey.milestone('reopen', async () => { await page.reload(); });
});`;

test('review rejects unresolved descriptive placeholders but preserves drafts for correction', () => {
  for (const value of ['<the unique title entered>', '<unique note>']) {
    const item = caseWith(value);
    assert.doesNotThrow(() => assertReviewedJourneys([{ ...item, needsReview: true }]));
    assert.throws(() => assertReviewedJourneys([item]), /placeholder|concrete|\{run\}/i, value);
  }
  for (const value of ['Note {run}', 'Use <article> for this content', '<generated>', '<generated-value>', '<saved />', 'Hello {{customer_name}}', '{{saved_title}}', 'a < b', '{ "status": "ok" }']) {
    assert.doesNotThrow(() => assertReviewedJourneys([caseWith(value)]), value);
  }
});

test('an unchanged legacy placeholder does not prevent editing another journey or deselecting it', () => {
  const legacy = { ...caseWith('<the unique title entered>'), id: 'legacy', selected: true };
  const other = { ...caseWith('Note {run}'), id: 'other' };
  assert.doesNotThrow(() => assertReviewedJourneys([{ ...legacy, selected: false }, other], [legacy]));
  assert.throws(() => assertReviewedJourneys([{ ...legacy, name: 'Changed journey' }], [legacy]), /placeholder|concrete/i);
});

test('a generated spec cannot read this run’s data without first typing the real run token', () => {
  const item = caseWith('Note {run}');
  for (const literal of ['Note journey.run', 'Note {run}', 'Note from a previous run']) {
    assert.throws(() => validateJourneySpec(code(`await page.getByLabel('Title').fill(${JSON.stringify(literal)}); await page.reload();`), item), /run.*token|journey\.run/i);
  }
  const valid = code('await page.getByLabel("Title").fill(`Note ${journey.run}`); await page.reload();');
  assert.equal(validateJourneySpec(valid, item), valid);
  // Literal content is legitimate when the reviewed check actually requests it.
  const literal = code("await page.getByLabel('Title').fill('The journey.run API'); await page.reload();");
  assert.equal(validateJourneySpec(literal, caseWith('The journey.run API')), literal);
});

test('final run-owned checks require a real token input, but absence-only checks do not invent writes', () => {
  const plain = { ...caseWith('Saved'), assertions: [{ type: 'text-visible' as const, value: 'Note {run}' }] };
  assert.throws(() => validateJourneySpec(code("await page.reload();"), plain), /run.*token|journey\.run/i);
  const absent = { ...caseWith('Saved'), assertions: [{ type: 'text-absent' as const, value: 'Unwanted {run}' }] };
  assert.doesNotThrow(() => validateJourneySpec(code('await page.reload();'), absent));
});
