/**
 * Google sign-in for the admin UI.
 *
 * Separate from the Google Photos connection (googlePhotos.ts): this flow only asks for
 * the user's identity (`openid email`) so the server can check it against the
 * FRAME_ADMIN_EMAILS allowlist and issue the same signed session cookie as the password
 * login. It reuses the GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET credentials — just register
 * the extra redirect URI (/api/auth/google/callback) on the same OAuth client.
 */

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

/** Consent-screen URL for the admin sign-in (identity only, always ask which account). */
export function adminAuthUrl(state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: CLIENT_ID ?? '',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email',
    prompt: 'select_account',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Exchange the authorization code for the signed-in user's email.
 *
 * The id_token arrives directly from Google's token endpoint over TLS in exchange for our
 * client secret, so decoding its payload without re-verifying the JWT signature is safe here
 * (we are the party the token was minted for, on the same round trip).
 */
export async function exchangeCodeForEmail(
  code: string,
  redirectUri: string,
): Promise<{ email: string; emailVerified: boolean }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID ?? '',
      client_secret: CLIENT_SECRET ?? '',
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  const json = (await res.json()) as { id_token?: string };
  if (!json.id_token) throw new Error('Token response missing id_token');
  const payload = decodeJwtPayload(json.id_token) as { email?: string; email_verified?: boolean };
  if (!payload.email) throw new Error('id_token missing email');
  return { email: payload.email, emailVerified: payload.email_verified === true };
}

function decodeJwtPayload(jwt: string): unknown {
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('malformed id_token');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}
