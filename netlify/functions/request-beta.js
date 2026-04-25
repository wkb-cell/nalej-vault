const {
  buildEmailPackage,
  evaluateSubmission,
  normalizeSubmission,
  validateSubmission,
} = require("./lib/conversion-system.js");

async function sendWithResend(emailPackage, submission, routing) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;

  if (!apiKey) {
    throw new Error("Missing RESEND_API_KEY.");
  }

  if (!from) {
    throw new Error("Missing RESEND_FROM_EMAIL.");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `${submission.email}:${submission.submittedAt}:${routing.score}`,
    },
    body: JSON.stringify({
      from,
      to: [emailPackage.to],
      subject: emailPackage.subject,
      text: emailPackage.body,
      reply_to: submission.email,
      tags: [
        { name: "source", value: "nalej_beta_intake" },
        { name: "beta_gate", value: routing.betaGate },
        { name: "priority", value: routing.priority },
      ],
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.message || payload.error || "Resend send failed.");
  }

  return payload;
}

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: JSON.stringify(payload),
  };
}

exports.handler = async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed." });
  }

  let rawBody = {};
  try {
    rawBody = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: "Request body must be valid JSON." });
  }

  const submission = normalizeSubmission(rawBody);
  const validation = validateSubmission(submission);

  if (!validation.ok) {
    return json(400, { error: validation.error });
  }

  const routing = evaluateSubmission(submission, process.env);
  const emailPackage = buildEmailPackage(submission, routing, process.env);

  try {
    const delivery = await sendWithResend(emailPackage, submission, routing);
    return json(200, {
      ok: true,
      routing,
      delivery,
    });
  } catch (error) {
    return json(502, {
      error: error.message || "Automatic email delivery failed.",
      routing,
    });
  }
};