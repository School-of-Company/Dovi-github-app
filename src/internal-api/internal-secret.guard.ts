import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import type { Request } from 'express';

export const INTERNAL_SECRET_HEADER = 'x-dovi-internal-secret';

// ai-server 등 내부 서비스 → github-app 호출을 공유 시크릿으로 인증한다. GitHub 웹훅
// 서명(WebhookSignatureGuard)과는 별개 — 호출 주체와 비밀 값이 다르다.
@Injectable()
export class InternalSecretGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const secret = process.env.GITHUB_APP_INTERNAL_SECRET;
    // 시크릿이 없으면 엔드포인트 자체를 닫는다(빈 값과 비교해 통과되는 일이 없게).
    if (!secret) {
      throw new ServiceUnavailableException('Internal API is not configured');
    }

    const req = context.switchToHttp().getRequest<Request>();
    const provided = req.headers[INTERNAL_SECRET_HEADER];
    if (typeof provided !== 'string' || provided === '') {
      throw new UnauthorizedException();
    }

    // 길이가 다른 값끼리는 timingSafeEqual이 예외를 던지고, 그 자체로 길이가 드러난다.
    // 둘 다 고정 길이 해시로 바꿔 비교한다.
    const expected = createHash('sha256').update(secret).digest();
    const actual = createHash('sha256').update(provided).digest();
    if (!timingSafeEqual(expected, actual)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}
