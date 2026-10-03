import crypto from 'node:crypto';

const COOKIE = 'bench_session';
const MAX_AGE_DAYS = 60;

const hmac = (secret, value) => crypto.createHmac('sha256', secret).update(value).digest('base64url');
const sha = s => crypto.createHash('sha256').update(String(s)).digest();

export function passwordMatches(input, expected) {
  // Hashes gleicher Länge vergleichen, damit timingSafeEqual nicht an der Länge scheitert.
  return crypto.timingSafeEqual(sha(input), sha(expected));
}

export function makeToken(secret) {
  const exp = Date.now() + MAX_AGE_DAYS * 86400e3;
  return `${exp}.${hmac(secret, 'bench:' + exp)}`;
}

export function tokenValid(secret, token) {
  if (!token) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || !(Number(exp) > Date.now())) return false;
  const want = Buffer.from(hmac(secret, 'bench:' + exp));
  const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

export function readCookie(req, name = COOKIE) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function setSessionCookie(req, res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: req.secure,
    sameSite: 'lax',
    maxAge: MAX_AGE_DAYS * 86400e3,
    path: '/'
  });
}

export function clearSessionCookie(req, res) {
  res.clearCookie(COOKIE, { httpOnly: true, secure: req.secure, sameSite: 'lax', path: '/' });
}

// Einfache Bremse gegen Passwort-Raten: 10 Fehlversuche pro IP in 15 Minuten.
const fails = new Map();
const WINDOW = 15 * 60e3, LIMIT = 10;
export function loginBlocked(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.first > WINDOW) return false;
  return f.n >= LIMIT;
}
export function noteFailure(ip) {
  const f = fails.get(ip);
  if (!f || Date.now() - f.first > WINDOW) fails.set(ip, { first: Date.now(), n: 1 });
  else f.n++;
}
export function clearFailures(ip) { fails.delete(ip); }
