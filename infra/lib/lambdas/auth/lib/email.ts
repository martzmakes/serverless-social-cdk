import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

const ses = new SESv2Client({});
const FROM = process.env.SES_FROM_ADDRESS!;

/**
 * Sends a magic-link email. The link resolves to the HTTP API's /auth/verify
 * endpoint, which (on success) redirects / deep-links back into the app with
 * a minted JWT.
 */
export async function sendMagicLinkEmail(
  to: string,
  verifyUrl: string
): Promise<void> {
  const subject = "Your sign-in link";
  const textBody = [
    "Tap the link below to sign in:",
    "",
    verifyUrl,
    "",
    "This link expires in 15 minutes and can only be used once.",
    "If you didn't request this, you can safely ignore this email.",
  ].join("\n");
  const htmlBody = `
    <div style="font-family: 'General Sans', -apple-system, Segoe UI, Roboto, sans-serif; background: #07090C; color: #EEF1F6; padding: 32px 24px; border-radius: 10px; max-width: 480px; margin: 0 auto; border: 1px solid rgba(255,255,255,0.1);">
      <div style="font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace; font-size: 11px; letter-spacing: 0.08em; color: #8892A0; text-transform: uppercase; margin: 0 0 12px;">SIGN IN</div>
      <h1 style="font-family: 'General Sans', -apple-system, sans-serif; color: #EEF1F6; margin: 0 0 12px; font-size: 24px; font-weight: 600; letter-spacing: -0.02em;">Sign in</h1>
      <p style="line-height: 1.5; margin: 0 0 24px; color: #B8C0CC; font-size: 15px;">Tap the button below to sign in. This link expires in 15 minutes and can only be used once.</p>
      <p style="margin: 0 0 24px;">
        <a href="${verifyUrl}" style="display: inline-block; background: #3B82FF; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-weight: 500; font-family: 'General Sans', -apple-system, sans-serif; font-size: 14px;">Sign in</a>
      </p>
      <p style="font-size: 12px; color: #8892A0; line-height: 1.5; margin: 0; font-family: 'JetBrains Mono', ui-monospace, monospace;">Or paste this URL into your browser:<br><span style="word-break: break-all;">${verifyUrl}</span></p>
      <p style="font-size: 12px; color: #5D6674; margin: 24px 0 0; font-family: 'General Sans', -apple-system, sans-serif;">If you didn't request this, you can safely ignore this email.</p>
    </div>
  `;

  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: FROM,
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: textBody, Charset: "UTF-8" },
            Html: { Data: htmlBody, Charset: "UTF-8" },
          },
        },
      },
    })
  );
}
