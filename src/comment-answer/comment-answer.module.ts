import { Module } from '@nestjs/common';
import { CommentAnswerCollectorService } from './comment-answer-collector.service';
import { CommentAnswerDispatcherService } from './comment-answer-dispatcher.service';

@Module({
  providers: [CommentAnswerCollectorService, CommentAnswerDispatcherService],
  exports: [CommentAnswerCollectorService, CommentAnswerDispatcherService],
})
export class CommentAnswerModule {}
