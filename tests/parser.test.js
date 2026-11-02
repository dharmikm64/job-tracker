const test = require('node:test');
const assert = require('node:assert');
require('./helpers/load').loadApp();
const { E } = require('./fixtures/emails');

const ELIGIBLE = ['Spring 2027', 'Summer 2027'];
const eligibility = (x) => TermDetector.eligibility({ term: x.term, status: x.termStatus }, ELIGIBLE);

test('2026 email about a Summer 2027 role is eligible (term, not received date)', () => {
  const x = EmailParser.parse(E.acmeConfirm);
  assert.strictEqual(x.emailDate.getFullYear(), 2026);
  assert.strictEqual(x.term, 'Summer 2027');
  assert.strictEqual(eligibility(x), 'ELIGIBLE');
  assert.strictEqual(x.eventType, 'APPLIED');
  assert.strictEqual(x.company, 'Acme Robotics');
  assert.strictEqual(x.role, 'Software Engineer Intern');
  assert.strictEqual(x.reqId, 'R-10452');
  assert.strictEqual(x.location, 'Boston, MA');
});

test('Spring 2027 co-op confirmation is detected and eligible', () => {
  const x = EmailParser.parse(E.northwindCoop);
  assert.strictEqual(x.term, 'Spring 2027');
  assert.strictEqual(eligibility(x), 'ELIGIBLE');
  assert.strictEqual(x.role, 'Embedded Software Co-op');
  assert.strictEqual(x.company, 'Northwind Systems');
  assert.strictEqual(x.reqId, 'JR-88123');
});

test('Summer 2026 application is ineligible', () => {
  const x = EmailParser.parse(E.globex2026);
  assert.strictEqual(x.term, 'Summer 2026');
  assert.strictEqual(eligibility(x), 'INELIGIBLE');
});

test('graduation year is not mistaken for the hiring term', () => {
  const x = EmailParser.parse(E.initechGrad);
  assert.strictEqual(x.term, '');
  assert.strictEqual(eligibility(x), 'UNKNOWN');
});

test('a bare year or season alone is never a term', () => {
  assert.deepStrictEqual(TermDetector.findTerms('Our 2027 internship program opens this summer.'), []);
  assert.deepStrictEqual(TermDetector.findTerms('Summer 27 cohort'), []);
  assert.deepStrictEqual(TermDetector.findTerms("Summer '27 cohort"), ['Summer 2027']);
  assert.deepStrictEqual(TermDetector.findTerms('Class of 2027, graduating Spring 2027'), []);
  assert.deepStrictEqual(TermDetector.findTerms('2027 Summer Analyst'), ['Summer 2027']);
  assert.deepStrictEqual(TermDetector.findTerms('Co-op term: May - August 2027'), ['Summer 2027']);
});

test('several terms in the body is a conflict; a single subject term wins', () => {
  assert.strictEqual(TermDetector.detect('Update', 'Fall 2026 or Spring 2027 co-op').status, 'CONFLICT');
  const r = TermDetector.detect('Intern - Summer 2027', 'Our Summer 2026 interns loved it');
  assert.strictEqual(r.term, 'Summer 2027');
});

test('dates in footers are ignored', () => {
  const x = EmailParser.parse({ ...E.acmeConfirm, body: 'Thank you for applying to Acme Robotics for the Software Engineer Intern position.\n\nThanks\nTeam\n\nUnsubscribe | Summer 2026 events at Acme' });
  assert.strictEqual(x.term, '');
});

test('newsletter mentioning interviews is an ad, not an application event', () => {
  const x = EmailParser.parse(E.newsletter);
  assert.strictEqual(x.relevance, 'AD');
  assert.strictEqual(x.eventType, '');
});

test('event classification: rejection beats "thank you for applying", interview beats confirmation', () => {
  assert.strictEqual(EmailParser.parse(E.acmeReject).eventType, 'REJECTED');
  assert.strictEqual(EmailParser.parse(E.hooliInterview).eventType, 'INTERVIEW');
  assert.strictEqual(EmailParser.parse(E.acmeReminder).eventType, 'REMINDER');
});

test('explicit applied date and deadline are extracted; nothing is invented', () => {
  const late = EmailParser.parse(E.hooliLateConfirm);
  assert.strictEqual(late.appliedDate.toDateString(), new Date(2026, 8, 20).toDateString());
  const rem = EmailParser.parse(E.acmeReminder);
  assert.strictEqual(rem.deadline.toDateString(), new Date(2026, 9, 8).toDateString());
  const interview = EmailParser.parse(E.hooliInterview);
  assert.strictEqual(interview.appliedDate, null);
  assert.strictEqual(interview.location, '');
  assert.strictEqual(interview.reqId, '');
});

test('sender domain is not used as the company', () => {
  const x = EmailParser.parse({ id: 'x', threadId: 'x', date: new Date('2026-09-01'),
    from: 'Jane Smith <jane@bigplatform.example>', subject: 'Hello', body: 'We received your application. Thanks!' });
  assert.strictEqual(x.company, '');
});

test('extra extractors only fill blank fields (LLM hook)', () => {
  EmailParser.registerExtractor(() => ({ company: 'Overwritten?', location: 'Remote' }));
  const x = EmailParser.parse(E.contosoSwe);
  EmailParser.clearExtractors();
  assert.strictEqual(x.company, 'Contoso');
  assert.strictEqual(x.location, 'Remote');
});
