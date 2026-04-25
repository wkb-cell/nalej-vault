const USE_CASE_LABELS = {
  "screening-opportunities": "Screening multiple opportunities",
  "front-end-triage": "Need consistent front-end triage",
  "multi-stakeholder": "Multiple stakeholders involved in decisions",
  "advisory-conclusions": "Seeking advisory conclusions",
  "one-off-research": "One-off research or data gathering",
};

const VOLUME_LABELS = {
  "1-5": "1-5",
  "6-15": "6-15",
  "16-40": "16-40",
  "40+": "40+",
};

function toText(value) {
  return String(value || "").trim();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeSubmission(raw) {
  return {
    name: toText(raw.name),
    organization: toText(raw.organization),
    role: toText(raw.role),
    email: toText(raw.email).toLowerCase(),
    useCase: toText(raw.useCase),
    volume: toText(raw.volume),
    context: toText(raw.context),
    source: toText(raw.source) || "nalej-landing-page",
    submittedAt: raw.submittedAt || new Date().toISOString(),
  };
}

function validateSubmission(submission) {
  const required = ["name", "organization", "role", "email", "useCase", "volume", "context"];

  for (const field of required) {
    if (!submission[field]) {
      return { ok: false, error: `Missing required field: ${field}` };
    }
  }

  if (!isValidEmail(submission.email)) {
    return { ok: false, error: "Email address is not valid." };
  }

  if (!USE_CASE_LABELS[submission.useCase]) {
    return { ok: false, error: "Use case value is not recognized." };
  }

  if (!VOLUME_LABELS[submission.volume]) {
    return { ok: false, error: "Volume value is not recognized." };
  }

  return { ok: true };
}

function scoreUseCase(submission, notes, factors) {
  const highFitUseCases = [
    "screening-opportunities",
    "front-end-triage",
    "multi-stakeholder",
  ];

  if (highFitUseCases.includes(submission.useCase)) {
    notes.push("Use case aligns with structured front-end diligence.");
    factors.push({ factor: "use_case_fit", score: 35 });
    return 35;
  }

  notes.push("Use case suggests a lower-fit entry point.");
  factors.push({ factor: "use_case_fit", score: 0 });
  return 0;
}

function scoreVolume(submission, notes, factors) {
  if (submission.volume === "6-15") {
    notes.push("Opportunity volume supports meaningful repeat use.");
    factors.push({ factor: "screening_volume", score: 20 });
    return 20;
  }

  if (submission.volume === "16-40" || submission.volume === "40+") {
    notes.push("Higher opportunity volume increases beta relevance.");
    factors.push({ factor: "screening_volume", score: 30 });
    return 30;
  }

  notes.push("Lower opportunity volume may reduce urgency for beta deployment.");
  factors.push({ factor: "screening_volume", score: 10 });
  return 10;
}

function scoreRole(submission, factors) {
  const score = submission.role.length >= 6 ? 10 : 0;
  factors.push({ factor: "role_signal", score });
  return score;
}

function scoreContext(submission, notes, factors) {
  const score = submission.context.length >= 40 ? 15 : 0;
  if (score) {
    notes.push("Context is detailed enough for qualification review.");
  }
  factors.push({ factor: "context_quality", score });
  return score;
}

function scoreEmail(submission, factors) {
  const personalDomains = ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com"];
  const domain = submission.email.split("@")[1] || "";
  const score = domain && !personalDomains.includes(domain) ? 10 : 5;
  factors.push({ factor: "email_signal", score });
  return score;
}

function deriveCohortGate(score, env) {
  const limit = Number.parseInt(env.BETA_MAX_FOUNDING_COHORT_SIZE || "0", 10);
  const current = Number.parseInt(env.BETA_CURRENT_FOUNDING_COUNT || "0", 10);
  const capacityKnown = Number.isFinite(limit) && limit > 0;
  const hasCapacity = !capacityKnown || current < limit;

  if (score >= 75 && hasCapacity) {
    return {
      betaGate: "founding_open",
      cohort: "Founding cohort candidate",
    };
  }

  if (score >= 75 && !hasCapacity) {
    return {
      betaGate: "founding_waitlist",
      cohort: "Founding cohort waitlist",
    };
  }

  if (score >= 50) {
    return {
      betaGate: "secondary_review",
      cohort: "Secondary cohort",
    };
  }

  return {
    betaGate: "nurture_hold",
    cohort: "Outside founding cohort",
  };
}

function evaluateSubmission(submission, env = process.env) {
  const notes = [];
  const scoringFactors = [];

  let score = 0;
  score += scoreUseCase(submission, notes, scoringFactors);
  score += scoreVolume(submission, notes, scoringFactors);
  score += scoreRole(submission, scoringFactors);
  score += scoreContext(submission, notes, scoringFactors);
  score += scoreEmail(submission, scoringFactors);

  const gate = deriveCohortGate(score, env);

  let status = "Needs review";
  let path = "Standard review";
  let tone = "status-review";
  let routeTo = "beta_standard_queue";
  let nextStep = "Internal qualification review";
  let priority = "normal";

  if (gate.betaGate === "founding_open") {
    status = "Qualified for direct follow-up";
    path = "Priority beta review";
    tone = "status-qualified";
    routeTo = "beta_priority_queue";
    nextStep = env.BETA_MEETING_LINK_PRIORITY
      ? "Direct scheduling link"
      : "Priority outreach and scheduling";
    priority = "high";
    notes.unshift("Signal strength supports immediate beta review.");
  } else if (gate.betaGate === "founding_waitlist") {
    status = "Qualified with cohort waitlist";
    path = "Founding cohort waitlist review";
    tone = "status-review";
    routeTo = "beta_waitlist_queue";
    nextStep = "Waitlist review and timed follow-up";
    priority = "medium";
    notes.unshift("Fit is strong, but founding cohort capacity is currently constrained.");
  } else if (gate.betaGate === "secondary_review") {
    status = "Qualified for structured review";
    path = "Standard beta review";
    tone = "status-review";
    routeTo = "beta_standard_queue";
    nextStep = env.BETA_MEETING_LINK_STANDARD
      ? "Optional standard scheduling link"
      : "Standard qualification review";
    priority = "medium";
    notes.unshift("Submission appears viable but may require additional screening.");
  } else {
    status = "Not currently prioritized";
    path = "Hold or standard tier follow-up";
    tone = "status-hold";
    routeTo = "beta_hold_queue";
    nextStep = "Hold, nurture, or redirect";
    priority = "low";
    notes.unshift("Submission currently reads as lower fit for the founding beta group.");
  }

  return {
    score,
    status,
    path,
    cohort: gate.cohort,
    betaGate: gate.betaGate,
    routeTo,
    nextStep,
    priority,
    tone,
    scoringFactors,
    notes: notes.join(" "),
  };
}

function buildEmailPackage(submission, routing, env = process.env) {
  const to = env.BETA_REQUEST_EMAIL_TO || "wkb@jfb.fyi";
  const subject = `Näləj Beta Intake | ${submission.organization} | ${routing.score}/100`;
  const lines = [
    "Näləj Beta Intake Request",
    "",
    `Submitted: ${submission.submittedAt}`,
    `Source: ${submission.source}`,
    "",
    "Contact",
    `Name: ${submission.name}`,
    `Organization: ${submission.organization}`,
    `Role: ${submission.role}`,
    `Email: ${submission.email}`,
    "",
    "Intake",
    `Use case: ${USE_CASE_LABELS[submission.useCase]}`,
    `Volume: ${VOLUME_LABELS[submission.volume]}`,
    `Context: ${submission.context}`,
    "",
    "Qualification",
    `Status: ${routing.status}`,
    `Path: ${routing.path}`,
    `Cohort: ${routing.cohort}`,
    `Beta gate: ${routing.betaGate}`,
    `Next step: ${routing.nextStep}`,
    `Score: ${routing.score}/100`,
    `Notes: ${routing.notes}`,
  ];

  return {
    to,
    subject,
    body: lines.join("\n"),
    mailtoHref:
      `mailto:${encodeURIComponent(to)}` +
      `?subject=${encodeURIComponent(subject)}` +
      `&body=${encodeURIComponent(lines.join("\n"))}`,
  };
}

module.exports = {
  buildEmailPackage,
  evaluateSubmission,
  normalizeSubmission,
  validateSubmission,
};