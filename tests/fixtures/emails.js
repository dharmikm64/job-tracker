// Synthetic recruiting emails. All companies, people and IDs are made up.
// Never put real email content in this folder (see .gitignore).

function d(s) { return new Date(s); }

const E = {
  // 1. Received in 2026, about a Summer 2027 role.
  acmeConfirm: {
    id: 'm-acme-1', threadId: 't-acme-1', date: d('2026-09-15T10:00:00'),
    from: 'Acme Robotics Careers <no-reply@greenhouse.io>',
    subject: 'Thank you for applying to Acme Robotics',
    body: `Hi Alex,

Thank you for applying to Acme Robotics! We have received your application for the Software Engineer Intern - Summer 2027 position (Req ID: R-10452).

Location: Boston, MA

Our team will review your application and reach out if there is a fit.

Best,
The Acme Robotics Recruiting Team

© 2026 Acme Robotics, Inc. | Privacy Policy | Unsubscribe`
  },

  // 2. Spring 2027 co-op confirmation (term in subject, month range in body).
  northwindCoop: {
    id: 'm-nw-1', threadId: 't-nw-1', date: d('2026-08-20T09:30:00'),
    from: 'Northwind Systems <northwind@myworkday.com>',
    subject: 'Application Received: Embedded Software Co-op (Spring 2027)',
    body: `Dear Candidate,

Thank you for your application to the Embedded Software Co-op (January - April 2027) role at Northwind Systems. Job ID: JR-88123.

We will contact you if your qualifications match our needs.

Northwind Systems Talent Acquisition`
  },

  // 3. Summer 2026: out of scope, must be ignored.
  globex2026: {
    id: 'm-globex-1', threadId: 't-globex-1', date: d('2026-07-01T12:00:00'),
    from: 'Globex Recruiting <jobs@globex.example>',
    subject: 'Thanks for applying to Globex',
    body: `Thank you for applying to Globex for the Data Science Intern, Summer 2026 role. We have received your application.`
  },

  // 4. Mentions graduation in 2027 but no hiring term.
  initechGrad: {
    id: 'm-initech-1', threadId: 't-initech-1', date: d('2026-09-01T08:00:00'),
    from: 'Initech Careers <careers@initech.example>',
    subject: 'Your application to Initech',
    body: `Thank you for applying to Initech! We received your application for the Software Developer Intern position.

As a reminder of the eligibility requirements: candidates should have an expected graduation date of Spring 2027 or later (Class of 2027).

Initech Recruiting`
  },

  // 5. Rejection with no term, separate thread, names the role.
  acmeReject: {
    id: 'm-acme-2', threadId: 't-acme-2', date: d('2026-10-20T15:00:00'),
    from: 'Acme Robotics Careers <no-reply@greenhouse.io>',
    subject: 'Update on your application',
    body: `Hi Alex,

Thank you for your interest in the Software Engineer Intern position at Acme Robotics. After careful consideration, we have decided not to move forward with your application.

We wish you the best in your search.`
  },

  // 5b. Rejection reply in the same thread as a confirmation, no role, no term.
  acmeThreadReject: {
    id: 'm-acme-3', threadId: 't-acme-1', date: d('2026-10-21T15:00:00'),
    from: 'Acme Robotics Careers <no-reply@greenhouse.io>',
    subject: 'Re: Thank you for applying to Acme Robotics',
    body: `Hi Alex, unfortunately we will not be moving forward at this time. Thanks again.`
  },

  // 6. Two different roles at the same company.
  contosoSwe: {
    id: 'm-contoso-1', threadId: 't-contoso-1', date: d('2026-09-10T10:00:00'),
    from: 'Contoso University Recruiting <no-reply@lever.co>',
    subject: 'Thank you for applying to Contoso',
    body: `Thanks for applying to Contoso! We've received your application for the Software Engineer Intern (Summer 2027) role.

Contoso University Recruiting`
  },
  contosoPm: {
    id: 'm-contoso-2', threadId: 't-contoso-1', // Gmail threaded the look-alike subject
    date: d('2026-09-11T10:00:00'),
    from: 'Contoso University Recruiting <no-reply@lever.co>',
    subject: 'Thank you for applying to Contoso',
    body: `Thanks for applying to Contoso! We've received your application for the Product Manager Intern (Summer 2027) role.

Contoso University Recruiting`
  },
  contosoPmInterview: {
    id: 'm-contoso-3', threadId: 't-contoso-3', date: d('2026-10-05T10:00:00'),
    from: 'Jordan Lee <jordan@contoso.example>',
    subject: 'Interview invitation - Product Manager Intern',
    body: `Hi Alex,

We'd like to invite you to interview for the Product Manager Intern position at Contoso. Please share your availability for an interview by October 12, 2026.

Jordan`
  },

  // 7. Interview first, then a delayed confirmation.
  hooliInterview: {
    id: 'm-hooli-1', threadId: 't-hooli-1', date: d('2026-10-01T09:00:00'),
    from: 'Hooli Recruiting <recruiting@hooli.example>',
    subject: 'Next steps with Hooli',
    body: `Thank you for applying to Hooli. We would like to invite you to interview for the Software Engineering Intern, Summer 2027 position. Please share your availability.`
  },
  hooliLateConfirm: {
    id: 'm-hooli-2', threadId: 't-hooli-2', date: d('2026-10-03T09:00:00'),
    from: 'Hooli Careers <no-reply@ashbyhq.com>',
    subject: 'Application received: Software Engineering Intern, Summer 2027',
    body: `Thank you for applying to Hooli. You submitted your application on September 20, 2026 for the Software Engineering Intern, Summer 2027 position.`
  },

  // 8. Newsletter that talks about interviews.
  newsletter: {
    id: 'm-news-1', threadId: 't-news-1', date: d('2026-09-05T07:00:00'),
    from: 'Handshake <noreply@joinhandshake.com>',
    subject: 'This week: how to ace your next interview',
    body: `Handshake Newsletter

Tips for your technical interview: practice out loud. Recruiters often schedule an interview within a week of reaching out.

Recommended jobs for you: Software Engineer Intern, Summer 2027 at Many Companies. Apply now!

Unsubscribe`
  },

  // 10. Ambiguous: company has two applications, email names no role.
  contosoVague: {
    id: 'm-contoso-4', threadId: 't-contoso-4', date: d('2026-10-25T10:00:00'),
    from: 'Contoso University Recruiting <no-reply@lever.co>',
    subject: 'An update from Contoso',
    body: `Hi Alex, we have decided not to move forward with your application at Contoso. Thank you for your time.`
  },

  // Extra: assessment reminder for Acme (no status change expected).
  acmeReminder: {
    id: 'm-acme-4', threadId: 't-acme-4', date: d('2026-10-01T10:00:00'),
    from: 'HackerRank <no-reply@hackerrankforwork.com>',
    subject: 'Reminder: complete your Acme Robotics assessment',
    body: `This is a reminder to complete the online assessment for the Software Engineer Intern position at Acme Robotics. Please complete it by October 8, 2026.`
  },

  // Extra: formula-looking company name must be stored as text.
  formulaCompany: {
    id: 'm-evil-1', threadId: 't-evil-1', date: d('2026-09-02T10:00:00'),
    from: 'Careers <careers@evil.example>',
    subject: 'Application received',
    body: `Position: =HYPERLINK("http://evil.example","Intern")
Thank you for applying to Evil Corp for the Summer 2027 internship. We received your application.`
  }
};

module.exports = { E };
