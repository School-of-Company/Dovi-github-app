import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';
import type { CommentAnswerContext } from './comment-answer-context.type';

const TTL_SECONDS = 60 * 60;

@Injectable()
export class CommentAnswerContextStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async get(commentJobId: string): Promise<CommentAnswerContext | null> {
    const raw = await this.redis.get(this.key(commentJobId));
    return raw ? (JSON.parse(raw) as CommentAnswerContext) : null;
  }

  async set(
    commentJobId: string,
    context: CommentAnswerContext,
  ): Promise<void> {
    await this.redis.set(
      this.key(commentJobId),
      JSON.stringify(context),
      'EX',
      TTL_SECONDS,
    );
  }

  private key(commentJobId: string): string {
    return `comment-answer:context:${commentJobId}`;
  }
}
