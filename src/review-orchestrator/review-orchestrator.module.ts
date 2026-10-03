import { Module } from '@nestjs/common';
import { DicoshotModule } from 'dicoshot-nest';
import { REVIEW_ORCHESTRATOR } from './review-orchestrator.interface';
import { ReviewFreshnessModule } from '../review-freshness/review-freshness.module';
import { ReviewOrchestratorService } from './review-orchestrator.service';
import { ReviewFailureNoticeService } from './review-failure-notice.service';

@Module({
  imports: [
    ReviewFreshnessModule,
    DicoshotModule.register({
      webhookUrl: process.env.DISCORD_WEBHOOK_URL ?? '',
      applicationName: 'dovi-github-app',
    }),
  ],
  providers: [
    ReviewFailureNoticeService,
    {
      provide: REVIEW_ORCHESTRATOR,
      useClass: ReviewOrchestratorService,
    },
  ],
  exports: [REVIEW_ORCHESTRATOR],
})
export class ReviewOrchestratorModule {}
