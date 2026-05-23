/** https://resend.com/docs/api-reference/emails/send-email */
const RESEND_API_URL = "https://api.resend.com/emails";

export type SendEmailParams = {
  from: string;
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
};

export type SendEmailResult = {
  id: string;
};

export class ResendError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ResendError";
  }
}

/**
 * Sends one email via Resend's REST API (no SDK — works in Workers).
 */
export async function sendEmail(
  apiKey: string,
  params: SendEmailParams
): Promise<SendEmailResult> {
  
  const res = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });

  const data = (await res.json()) as { id?: string; message?: string };

  if (!res.ok) {
    throw new ResendError(res.status, data.message ?? "Resend request failed");
  }

  if (!data.id) {
    throw new ResendError(res.status, "Resend response missing email id");
  }

  return { id: data.id };
}
