const SECRET_EXTENSIONS = ['.env', '.pem', '.p8', '.key'];

// ai-server의 app/review/context.py::_is_secret과 동일한 규칙 (1차 방어)
export function isSecretPath(path: string): boolean {
  const segments = path.toLowerCase().split('/');
  if (segments.includes('secrets')) return true;

  const name = segments[segments.length - 1];
  if (SECRET_EXTENSIONS.some((ext) => name.endsWith(ext))) return true;
  if (name === '.env' || name.startsWith('.env.')) return true;
  if (name.includes('private-key') || name.includes('private_key')) return true;

  return false;
}
