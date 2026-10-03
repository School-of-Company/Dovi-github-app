import { maskSecrets } from './secret-mask';

const GITHUB_TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4)}`; // 40자
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r';
const KEY_BODY =
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj';

describe('maskSecrets', () => {
  describe('형식이 뚜렷한 토큰', () => {
    it.each([
      ['GitHub 토큰', `const t = "${GITHUB_TOKEN}";`, GITHUB_TOKEN],
      ['AWS 액세스 키', `aws_key = ${AWS_KEY}`, AWS_KEY],
      ['JWT', `Authorization: Bearer ${JWT}`, JWT],
      [
        'Slack 웹훅',
        'url = https://hooks.slack.com/services/T0000000/B0000000/abcdefghijklmnopqrstuvwx',
        'abcdefghijklmnopqrstuvwx',
      ],
      [
        'Discord 웹훅',
        'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_-ABCDEF',
        'abcdefghijklmnopqrstuvwxyz_-ABCDEF',
      ],
      ['Slack 토큰', 'x = "xoxb-123456789012-abcdefghijkl"', 'abcdefghijkl'],
    ])('%s을(를) 가리고 앞 4글자만 남긴다', (_name, line, secret) => {
      const result = maskSecrets(line);

      expect(result.text).not.toContain(secret);
      expect(result.text).toContain('***');
      expect(result.count).toBe(1);
    });

    it('종류를 알 수 있게 접두사는 남긴다', () => {
      expect(maskSecrets(`x = ${GITHUB_TOKEN}`).text).toBe('x = ghp_***');
    });
  });

  describe('이름=따옴표 친 값', () => {
    it.each([
      ['password = "hunter2hunter2"', 'hunter2hunter2'],
      ["const apiKey = 'sk_live_abcdefgh12345'", 'sk_live_abcdefgh12345'],
      ['{"client_secret": "abcd1234efgh5678"}', 'abcd1234efgh5678'],
      ['DB_PASSWORD: "p@ssw0rd-long-enough"', 'p@ssw0rd-long-enough'],
      ['  private_key = `abcdefghijkl`', 'abcdefghijkl'],
    ])('%s 의 값을 가린다', (line, secret) => {
      const result = maskSecrets(line);

      expect(result.text).not.toContain(secret);
      expect(result.count).toBe(1);
    });

    it('이름과 따옴표는 남기고 값만 *** 로 바꾼다', () => {
      expect(maskSecrets('password = "hunter2hunter2"').text).toBe(
        'password = "***"',
      );
    });
  });

  describe('접속 URL의 비밀번호', () => {
    it.each([
      'postgres://admin:pa55word123@db.internal:5432/app',
      'redis://default:s3cr3tpassw0rd@cache:6379',
      'amqp://guest:long-guest-password@mq/vhost',
    ])('%s 의 비밀번호만 가린다', (url) => {
      const result = maskSecrets(`url = "${url}"`);

      expect(result.count).toBe(1);
      expect(result.text).toContain('***@');
      expect(result.text).not.toMatch(
        /pa55word123|s3cr3tpassw0rd|long-guest-password/,
      );
      // 사용자 이름과 호스트는 남아 어떤 접속 정보인지는 알 수 있다.
      expect(result.text).toMatch(/admin:|default:|guest:/);
    });

    it.each([
      'https://example.com/path',
      'postgres://user@host:5432/db',
      'postgres://user:${DB_PASSWORD}@host/db',
      'http://localhost:3000/api',
      'git@github.com:org/repo.git',
    ])('%s 는 그대로 둔다', (url) => {
      expect(maskSecrets(url).text).toBe(url);
    });
  });

  describe('가리지 않아야 하는 것 (오탐 방지)', () => {
    it.each([
      ['환경변수 참조', 'const t = process.env.API_TOKEN;'],
      ['따옴표 없는 값', 'const token = this.getToken();'],
      ['타입 선언', 'password: string;'],
      ['짧은 값', 'password = "abc"'],
      ['자리표시자', 'api_key = "your_api_key_here"'],
      ['템플릿 변수', 'token: "${{ secrets.TOKEN }}"'],
      ['이미 가려진 값', 'password = "***"'],
      ['커밋 해시', 'sha = "5c235e5a1b2c3d4e5f60718293a4b5c6d7e8f901"'],
      ['UUID', 'id = "123e4567-e89b-12d3-a456-426614174000"'],
      ['일반 식별자', 'const tokenizer = createTokenizer("whitespace-aware");'],
      ['테스트 값', 'secret = "test-secret-value"'],
      ['숫자만인 한도 설정', 'maxTokens = "12345678"'],
    ])('%s 는 그대로 둔다', (_name, line) => {
      const result = maskSecrets(line);

      expect(result.text).toBe(line);
      expect(result.count).toBe(0);
    });
  });

  describe('PRIVATE KEY 블록', () => {
    const block = [
      'const key = `',
      '-----BEGIN RSA PRIVATE KEY-----',
      KEY_BODY,
      KEY_BODY,
      '-----END RSA PRIVATE KEY-----',
      '`;',
    ].join('\n');

    it('본문 줄을 가리고 BEGIN/END 마커 줄은 남긴다', () => {
      const result = maskSecrets(block);

      expect(result.text).not.toContain(KEY_BODY);
      expect(result.text).toContain('-----BEGIN RSA PRIVATE KEY-----');
      expect(result.text).toContain('-----END RSA PRIVATE KEY-----');
    });

    it('줄 수를 보존한다', () => {
      const result = maskSecrets(block);

      expect(result.text.split('\n')).toHaveLength(block.split('\n').length);
    });

    it('한 줄로 이스케이프된 키도 가린다', () => {
      const line = `const k = "-----BEGIN PRIVATE KEY-----\\n${KEY_BODY}\\n-----END PRIVATE KEY-----";`;

      const result = maskSecrets(line);

      expect(result.text).not.toContain(KEY_BODY);
      expect(result.count).toBe(1);
    });

    it('PRIVATE KEY가 아닌 PEM(공개키, 인증서)은 건드리지 않는다', () => {
      const pem = `-----BEGIN PUBLIC KEY-----\n${KEY_BODY}\n-----END PUBLIC KEY-----`;

      expect(maskSecrets(pem).text).toBe(pem);
    });
  });

  describe('줄 수·위치 보존', () => {
    it('치환은 한 줄 안에서만 일어난다', () => {
      const input = [
        'line1',
        `token = "${GITHUB_TOKEN}"`,
        'line3',
        `aws = ${AWS_KEY}`,
        'line5',
      ].join('\n');

      const result = maskSecrets(input);
      const lines = result.text.split('\n');

      expect(lines).toHaveLength(5);
      expect(lines[0]).toBe('line1');
      expect(lines[2]).toBe('line3');
      expect(lines[4]).toBe('line5');
      expect(result.count).toBe(2);
    });
  });

  describe('diff(patch) 모드', () => {
    it('줄 맨 앞의 +/-/공백 접두사를 보존한다', () => {
      const patch = [
        '@@ -1,3 +1,3 @@',
        ' context',
        `-old = "${GITHUB_TOKEN}"`,
        `+new = "${GITHUB_TOKEN}"`,
      ].join('\n');

      const result = maskSecrets(patch, { diff: true });
      const lines = result.text.split('\n');

      expect(lines[0]).toBe('@@ -1,3 +1,3 @@');
      expect(lines[1]).toBe(' context');
      expect(lines[2].startsWith('-old = ')).toBe(true);
      expect(lines[3].startsWith('+new = ')).toBe(true);
      expect(result.text).not.toContain(GITHUB_TOKEN);
      expect(result.count).toBe(2);
    });

    it('추가된 PRIVATE KEY 블록의 본문 줄도 + 접두사를 유지한 채 가린다', () => {
      const patch = [
        '@@ -0,0 +1,4 @@',
        '+-----BEGIN PRIVATE KEY-----',
        `+${KEY_BODY}`,
        `+${KEY_BODY}`,
        '+-----END PRIVATE KEY-----',
      ].join('\n');

      const result = maskSecrets(patch, { diff: true });
      const lines = result.text.split('\n');

      expect(lines).toHaveLength(5);
      expect(lines[2]).toBe('+***');
      expect(lines[3]).toBe('+***');
      expect(result.text).not.toContain(KEY_BODY);
    });
  });

  it('시크릿이 없으면 입력을 그대로 돌려준다', () => {
    const input = 'export const add = (a: number, b: number) => a + b;\n';

    expect(maskSecrets(input)).toEqual({ text: input, count: 0 });
  });

  it('빈 문자열도 처리한다', () => {
    expect(maskSecrets('')).toEqual({ text: '', count: 0 });
  });

  it('반환값의 건수 정보에는 시크릿 값이 들어 있지 않다', () => {
    const result = maskSecrets(`x = "${GITHUB_TOKEN}"`);

    expect(JSON.stringify({ count: result.count })).not.toContain(GITHUB_TOKEN);
  });
});
