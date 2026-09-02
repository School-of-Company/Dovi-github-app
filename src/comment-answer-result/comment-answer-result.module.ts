import { Module } from '@nestjs/common';
import { DicoshotModule } from 'dicoshot-nest';
import { COMMENT_ANSWER_RESPONDER } from './comment-answer-responder.interface';
import { CommentAnswerResponderService } from './comment-answer-responder.service';
import { CommentAnswerResultConsumerService } from './comment-answer-result-consumer.service';

@Module({
  imports: [
    DicoshotModule.register({
      webhookUrl: process.env.DISCORD_WEBHOOK_URL ?? '',
      applicationName: 'dovi-github-app',
    }),
  ],
  providers: [
    {
      provide: COMMENT_ANSWER_RESPONDER,
      useClass: CommentAnswerResponderService,
    },
    CommentAnswerResultConsumerService,
  ],
})
export class CommentAnswerResultModule {}
